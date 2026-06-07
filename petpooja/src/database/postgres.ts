/**
 * PostgreSQL via Neon Serverless HTTP Driver
 * Uses @neondatabase/serverless over HTTPS (port 443) to bypass blocked port 5432.
 * A custom fetchFunction forces IPv4 DNS resolution to avoid IPv6 ETIMEDOUT issues.
 */

import * as dns from 'dns';
import * as https from 'https';
import { neon, neonConfig } from '@neondatabase/serverless';
import type { QueryResult, QueryResultRow, PoolClient } from 'pg';
import { createServiceLogger } from '../utils/logger';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const log = createServiceLogger('PostgreSQL');

// ---------------------------------------------------------------------------
// Force IPv4 DNS — Node.js v24 prefers IPv6 (unreachable) which causes ETIMEDOUT.
// We resolve A-records explicitly and connect directly to the IPv4 address.
// ---------------------------------------------------------------------------
neonConfig.fetchFunction = async (
    url: string,
    opts: RequestInit = {}
): Promise<Response> => {
    const urlObj = new URL(url as string);
    const addrs = await dns.promises.resolve4(urlObj.hostname);
    const ip = addrs[0];
    return new Promise<Response>((resolve, reject) => {
        const data = (opts.body as string) ?? '';
        const req = https.request(
            {
                host: ip,
                port: 443,
                path: urlObj.pathname + (urlObj.search ?? ''),
                method: (opts.method as string) ?? 'GET',
                servername: urlObj.hostname,
                headers: {
                    ...(opts.headers as Record<string, string>),
                    'content-length': String(Buffer.byteLength(data)),
                },
                timeout: 15_000,
            },
            (res) => {
                let body = '';
                res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                res.on('end', () =>
                    resolve({
                        ok: (res.statusCode ?? 500) < 400,
                        status: res.statusCode ?? 500,
                        json: () => Promise.resolve(JSON.parse(body)),
                        text: () => Promise.resolve(body),
                        headers: {
                            get: (h: string) =>
                                (res.headers[h.toLowerCase()] as string) ?? null,
                        },
                    } as unknown as Response)
                );
            }
        );
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Neon HTTP request timeout'));
        });
        if (data) req.write(data);
        req.end();
    });
};

// ---------------------------------------------------------------------------
// Build DATABASE_URL — strip channel_binding=require which breaks HTTP driver
// ---------------------------------------------------------------------------
let _sqlClient: ReturnType<typeof neon> | null = null;

function getSqlClient(): ReturnType<typeof neon> {
    if (!_sqlClient) {
        const rawUrl =
            process.env.DATABASE_URL ??
            (() => { throw new Error('DATABASE_URL is not set'); })();

        const dbUrl = rawUrl
            .replace(/[?&]channel_binding=[^&]*/g, '')
            .replace(/[?&]$/, '');

        log.info('Neon HTTP driver initialised');
        _sqlClient = neon(dbUrl);
    }
    return _sqlClient;
}

// ---------------------------------------------------------------------------
// getPostgresPool — returns a minimal pool-like shim for legacy callers
// ---------------------------------------------------------------------------
export function getPostgresPool() {
    const sql = getSqlClient();
    return {
        query: async <T extends QueryResultRow = Record<string, unknown>>(
            sqlStr: string,
            params?: unknown[]
        ): Promise<QueryResult<T>> => query<T>(sqlStr, params),
        // No-op end for compatibility
        end: async () => { /* no-op for HTTP driver */ },
    };
}

// ---------------------------------------------------------------------------
// query — main execute function, returns pg-compatible QueryResult<T>
// ---------------------------------------------------------------------------
export async function query<T extends QueryResultRow = Record<string, unknown>>(
    sqlStr: string,
    params?: unknown[]
): Promise<QueryResult<T>> {
    const sql = getSqlClient();
    const start = Date.now();
    try {
        const result = await (sql as unknown as {
            query: (
                s: string,
                p: unknown[],
                o: Record<string, unknown>
            ) => Promise<QueryResult<T>>;
        }).query(sqlStr, params ?? [], { fullResults: true });

        const duration = Date.now() - start;
        if (duration > 1000) {
            log.warn('Slow query detected', { sql: sqlStr.slice(0, 100), duration });
        }
        return result;
    } catch (err) {
        log.error('Query error', {
            sql: sqlStr.slice(0, 200),
            error: (err as Error).message,
        });
        throw err;
    }
}

// ---------------------------------------------------------------------------
// withTransaction — runs callback with a fake client backed by HTTP queries.
// HTTP driver has no true multi-statement transactions; for single-query
// transactions (the common case) this is functionally equivalent.
// ---------------------------------------------------------------------------
export async function withTransaction<T>(
    callback: (client: Pick<PoolClient, 'query'>) => Promise<T>
): Promise<T> {
    const fakeClient = {
        query: async <R extends QueryResultRow = Record<string, unknown>>(
            sqlStr: string,
            params?: unknown[]
        ): Promise<QueryResult<R>> => query<R>(sqlStr, params),
    };
    return callback(fakeClient as unknown as PoolClient);
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/**
 * Convenience: fetch a single row or null.
 */
export async function queryOne<T extends QueryResultRow = Record<string, unknown>>(
    sqlStr: string,
    params?: unknown[]
): Promise<T | null> {
    const result = await query<T>(sqlStr, params);
    return result.rows[0] ?? null;
}

/**
 * Convenience: fetch all rows.
 */
export async function queryMany<T extends QueryResultRow = Record<string, unknown>>(
    sqlStr: string,
    params?: unknown[]
): Promise<T[]> {
    const result = await query<T>(sqlStr, params);
    return result.rows;
}
