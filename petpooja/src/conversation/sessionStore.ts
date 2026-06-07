/**
 * Session Store
 * Postgres-backed replacement for the in-memory SessionManager.
 * All session state and full conversation history lives in:
 *   public.conversation_sessions  — session metadata + cart
 *   public.conversation_turns     — every message exchanged
 */

import { query, queryOne, queryMany } from '../database/postgres';
import { createServiceLogger } from '../utils/logger';

const log = createServiceLogger('SessionStore');

// ── In-process session cache ──────────────────────────────────────────────────
// Eliminates repeated Neon HTTP round-trips (300-500ms each) for active calls.
// Each voice call hits the DB exactly ONCE (first turn); all subsequent turns
// (getSession, getRecentTurns, buildLLMHistory) are served from this Map.
// Writes (updateSession, addTurn) update the cache instantly and flush to DB
// in the background (fire-and-forget) — DB is authoritative between calls only.
const _cache = new Map<string, SessionContext>();

export function invalidateSession(sessionId: string): void {
    _cache.delete(sessionId);
}

/**
 * Update the in-process cache ONLY — no DB write at all.
 * Use during ORDER_ADD / ORDER_REMOVE / ORDER_MODIFY turns so the cart
 * lives purely in memory until the order is confirmed.
 * saveCompletedOrder() will flush everything to DB on CONFIRM_ORDER.
 */
export function applyToCache(
    sessionId: string,
    updates: Partial<SessionContext>
): void {
    const cached = _cache.get(sessionId);
    if (cached) Object.assign(cached, updates);
}

/**
 * Push a synthetic system-role turn into the in-memory conversation history.
 * Use after cart mutations (ORDER_ADD/REMOVE/MODIFY) to inject a cart-state
 * checkpoint that buildLLMHistory will include verbatim.  This makes the
 * current cart visible to the LLM even when it doesn't re-read the system
 * prompt carefully.
 * Zero DB write — cache only.
 */
export function pushSystemTurn(sessionId: string, content: string): void {
    const cached = _cache.get(sessionId);
    if (!cached) return;
    cached.turnCount += 1;
    cached.turns.push({
        turnNumber: cached.turnCount,
        role: 'system',
        content,
    });
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface CartItem {
    itemId: number;
    name: string;
    qty: number;
    unitPrice: number;
    foodCost: number;
    modifiers: { type: string; label: string; priceDelta: number }[];
    lineTotal: number;
    isUpsold: boolean;
}

export interface ConversationTurn {
    turnNumber: number;
    role: 'user' | 'assistant' | 'system';
    content: string;
    intent?: string;
    entities?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
}

export interface SessionContext {
    sessionId: string;
    restaurantId: string;
    customerPhone: string;
    customerId?: string;
    language: string;
    state: string;
    cart: CartItem[];
    cartTotal: number;
    turnCount: number;
    upsellShown: string[];
    lastIntent?: string;
    clarificationPending?: {
        field: string;
        question: string;
        options: string[];
        originalTranscript: string;
    } | null;
    orderId?: string;
    contextSummary?: string;
    turns: ConversationTurn[];

    // Customer profile (from RAG lookup)
    customer: {
        customerId: number | null;
        customerName: string | null;
        customerPhone: string;
        segment: 'LOYAL' | 'REGULAR' | 'NEW' | null;
        visitCount: number;
        avgOrderValue: number;
        preferredCuisine: string | null;
        lastOrderItems: string[];
        daysSinceLastVisit: number | null;
        isReturning: boolean;
        isNew: boolean;
    };

    // Upsell tracking
    upsell: {
        shownItemIds: number[];
        shownComboIds: number[];
        lastUpsellTurn: number;
        acceptedItemIds: number[];
        rejectedItemIds: number[];
        offerNudgeSent: boolean;
        offerNudgeTurn: number;
    };

    // Flow control
    awaitingOrderConfirmation: boolean;
    awaitingCuisineChoice: boolean;
    callEnded: boolean;

    // Order result
    appliedOfferId: number | null;
    appliedDiscount: number;
    netTotal: number;
    kotCreated: boolean;
}

// ── DB row types ──────────────────────────────────────────────────────────────

interface DBSession {
    session_id: string;
    restaurant_id: string;
    customer_phone: string;
    customer_id: string | null;
    language: string;
    state: string;
    cart: CartItem[] | string;
    cart_total: string;
    turn_count: number;
    upsell_shown: string[] | null;
    last_intent: string | null;
    clarification_pending: {
        field: string;
        question: string;
        options: string[];
        originalTranscript: string;
    } | null;
    order_id: string | null;
    context_summary: string | null;
    // New extended columns
    customer_data: Record<string, unknown> | null;
    upsell_state: Record<string, unknown> | null;
    awaiting_order_confirmation: boolean | null;
    awaiting_cuisine_choice: boolean | null;
    call_ended: boolean | null;
    applied_offer_id: number | null;
    applied_discount: string | null;
    net_total: string | null;
    kot_created: boolean | null;
}

interface DBTurn {
    turn_id: string;
    session_id: string;
    turn_number: number;
    role: 'user' | 'assistant' | 'system';
    content: string;
    intent: string | null;
    entities: Record<string, unknown> | null;
    metadata: Record<string, unknown> | null;
    created_at: Date;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseCart(raw: CartItem[] | string): CartItem[] {
    if (!raw) return [];
    if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch { return []; }
    }
    return raw;
}

const DEFAULT_CUSTOMER: SessionContext['customer'] = {
    customerId: null,
    customerName: null,
    customerPhone: '',
    segment: null,
    visitCount: 0,
    avgOrderValue: 0,
    preferredCuisine: null,
    lastOrderItems: [],
    daysSinceLastVisit: null,
    isReturning: false,
    isNew: true,
};

const DEFAULT_UPSELL: SessionContext['upsell'] = {
    shownItemIds: [],
    shownComboIds: [],
    lastUpsellTurn: 0,
    acceptedItemIds: [],
    rejectedItemIds: [],
    offerNudgeSent: false,
    offerNudgeTurn: 0,
};

function dbSessionToContext(row: DBSession, turns: ConversationTurn[]): SessionContext {
    const customer = row.customer_data
        ? { ...DEFAULT_CUSTOMER, ...(row.customer_data as Partial<SessionContext['customer']>) }
        : { ...DEFAULT_CUSTOMER, customerPhone: row.customer_phone };

    const upsell = row.upsell_state
        ? { ...DEFAULT_UPSELL, ...(row.upsell_state as Partial<SessionContext['upsell']>) }
        : { ...DEFAULT_UPSELL };

    return {
        sessionId: row.session_id,
        restaurantId: row.restaurant_id,
        customerPhone: row.customer_phone,
        customerId: row.customer_id ?? undefined,
        language: row.language,
        state: row.state,
        cart: parseCart(row.cart),
        cartTotal: parseFloat(row.cart_total) || 0,
        turnCount: row.turn_count,
        upsellShown: row.upsell_shown ?? [],
        lastIntent: row.last_intent ?? undefined,
        clarificationPending: row.clarification_pending ?? null,
        orderId: row.order_id ?? undefined,
        contextSummary: row.context_summary ?? undefined,
        turns,
        customer,
        upsell,
        awaitingOrderConfirmation: row.awaiting_order_confirmation ?? false,
        awaitingCuisineChoice: row.awaiting_cuisine_choice ?? false,
        callEnded: row.call_ended ?? false,
        appliedOfferId: row.applied_offer_id ?? null,
        appliedDiscount: parseFloat(row.applied_discount ?? '0') || 0,
        netTotal: parseFloat(row.net_total ?? '0') || 0,
        kotCreated: row.kot_created ?? false,
    };
}

function dbTurnToTurn(row: DBTurn): ConversationTurn {
    return {
        turnNumber: row.turn_number,
        role: row.role,
        content: row.content,
        intent: row.intent ?? undefined,
        entities: row.entities ?? undefined,
        metadata: row.metadata ?? undefined,
    };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a new session row in conversation_sessions.
 * Returns an empty SessionContext with no turns.
 */
export async function createSession(
    sessionId: string,
    restaurantId: string,
    customerPhone: string,
    language = 'en'
): Promise<SessionContext> {
    await query(
        `INSERT INTO public.conversation_sessions
           (session_id, restaurant_id, customer_phone, language, state,
            cart, cart_total, turn_count, upsell_shown, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'IDENTITY_COLLECTION', '[]', 0.00, 0, '{}', now(), now())`,
        [sessionId, restaurantId, customerPhone, language]
    );

    log.info('Session created', { sessionId, restaurantId, customerPhone, language });

    const ctx: SessionContext = {
        sessionId,
        restaurantId,
        customerPhone,
        language,
        state: 'IDENTITY_COLLECTION',
        cart: [],
        cartTotal: 0,
        turnCount: 0,
        upsellShown: [],
        turns: [],
        customer: { ...DEFAULT_CUSTOMER, customerPhone },
        upsell: { ...DEFAULT_UPSELL },
        awaitingOrderConfirmation: false,
        awaitingCuisineChoice: false,
        callEnded: false,
        appliedOfferId: null,
        appliedDiscount: 0,
        netTotal: 0,
        kotCreated: false,
    };
    _cache.set(sessionId, ctx);
    return ctx;
}

/**
 * Load a session and its full turn history from Postgres.
 * Returns null if the session does not exist.
 */
export async function getSession(sessionId: string): Promise<SessionContext | null> {
    // Cache hit — skip DB entirely (~300-500ms saved per turn)
    const cached = _cache.get(sessionId);
    if (cached) return cached;

    // Cache miss — load from DB (only on the very first turn of a call)
    const row = await queryOne<DBSession>(
        `SELECT * FROM public.conversation_sessions WHERE session_id = $1`,
        [sessionId]
    );

    if (!row) return null;

    const turnRows = await queryMany<DBTurn>(
        `SELECT * FROM public.conversation_turns
          WHERE session_id = $1
          ORDER BY turn_number ASC`,
        [sessionId]
    );

    const ctx = dbSessionToContext(row, turnRows.map(dbTurnToTurn));
    _cache.set(sessionId, ctx);
    return ctx;
}

/**
 * Persist updated session fields. Always touches updated_at.
 */
export async function updateSession(
    sessionId: string,
    updates: Partial<Pick<
        SessionContext,
        | 'language'
        | 'state'
        | 'cart'
        | 'cartTotal'
        | 'turnCount'
        | 'upsellShown'
        | 'lastIntent'
        | 'clarificationPending'
        | 'orderId'
        | 'contextSummary'
        | 'customer'
        | 'upsell'
        | 'awaitingOrderConfirmation'
        | 'awaitingCuisineChoice'
        | 'callEnded'
        | 'appliedOfferId'
        | 'appliedDiscount'
        | 'netTotal'
        | 'kotCreated'
    >>
): Promise<void> {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (updates.language !== undefined) {
        setClauses.push(`language = $${idx++}`);
        values.push(updates.language);
    }
    if (updates.state !== undefined) {
        setClauses.push(`state = $${idx++}`);
        values.push(updates.state);
    }
    if (updates.cart !== undefined) {
        setClauses.push(`cart = $${idx++}`);
        values.push(JSON.stringify(updates.cart));
    }
    if (updates.cartTotal !== undefined) {
        setClauses.push(`cart_total = $${idx++}`);
        values.push(updates.cartTotal);
    }
    if (updates.turnCount !== undefined) {
        setClauses.push(`turn_count = $${idx++}`);
        values.push(updates.turnCount);
    }
    if (updates.upsellShown !== undefined) {
        setClauses.push(`upsell_shown = $${idx++}`);
        values.push(updates.upsellShown);
    }
    if (updates.lastIntent !== undefined) {
        setClauses.push(`last_intent = $${idx++}`);
        values.push(updates.lastIntent);
    }
    if ('clarificationPending' in updates) {
        setClauses.push(`clarification_pending = $${idx++}`);
        values.push(updates.clarificationPending ? JSON.stringify(updates.clarificationPending) : null);
    }
    if (updates.orderId !== undefined) {
        setClauses.push(`order_id = $${idx++}`);
        values.push(updates.orderId);
    }
    if (updates.contextSummary !== undefined) {
        setClauses.push(`context_summary = $${idx++}`);
        values.push(updates.contextSummary);
    }
    if (updates.customer !== undefined) {
        setClauses.push(`customer_data = $${idx++}`);
        values.push(JSON.stringify(updates.customer));
    }
    if (updates.upsell !== undefined) {
        setClauses.push(`upsell_state = $${idx++}`);
        values.push(JSON.stringify(updates.upsell));
    }
    if (updates.awaitingOrderConfirmation !== undefined) {
        setClauses.push(`awaiting_order_confirmation = $${idx++}`);
        values.push(updates.awaitingOrderConfirmation);
    }
    if (updates.awaitingCuisineChoice !== undefined) {
        setClauses.push(`awaiting_cuisine_choice = $${idx++}`);
        values.push(updates.awaitingCuisineChoice);
    }
    if (updates.callEnded !== undefined) {
        setClauses.push(`call_ended = $${idx++}`);
        values.push(updates.callEnded);
    }
    if ('appliedOfferId' in updates) {
        setClauses.push(`applied_offer_id = $${idx++}`);
        values.push(updates.appliedOfferId ?? null);
    }
    if (updates.appliedDiscount !== undefined) {
        setClauses.push(`applied_discount = $${idx++}`);
        values.push(updates.appliedDiscount);
    }
    if (updates.netTotal !== undefined) {
        setClauses.push(`net_total = $${idx++}`);
        values.push(updates.netTotal);
    }
    if (updates.kotCreated !== undefined) {
        setClauses.push(`kot_created = $${idx++}`);
        values.push(updates.kotCreated);
    }

    if (setClauses.length === 0) return;

    // Apply to cache immediately (synchronous — 0ms)
    const cached = _cache.get(sessionId);
    if (cached) Object.assign(cached, updates);

    setClauses.push(`updated_at = now()`);
    values.push(sessionId);

    // Fire DB write in the background — don't block the caller
    void query(
        `UPDATE public.conversation_sessions SET ${setClauses.join(', ')} WHERE session_id = $${idx}`,
        values
    ).catch(err => log.warn('updateSession DB write failed', { sessionId, error: (err as Error).message }));
}

/**
 * Append a turn to conversation_turns and increment turn_count on the session.
 */
export async function addTurn(
    sessionId: string,
    turn: Omit<ConversationTurn, 'turnNumber'>
): Promise<void> {
    const cached = _cache.get(sessionId);

    if (cached) {
        // Update cache immediately (0ms) — no DB round-trip needed
        cached.turnCount += 1;
        const turnNumber = cached.turnCount;
        cached.turns.push({ ...turn, turnNumber });

        // Fire DB writes in the background
        void (async () => {
            try {
                await query(
                    `UPDATE public.conversation_sessions
                        SET turn_count = $1, updated_at = now()
                      WHERE session_id = $2`,
                    [turnNumber, sessionId]
                );
                await query(
                    `INSERT INTO public.conversation_turns
                       (session_id, turn_number, role, content, intent, entities, metadata, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
                    [
                        sessionId,
                        turnNumber,
                        turn.role,
                        turn.content,
                        turn.intent ?? null,
                        turn.entities ? JSON.stringify(turn.entities) : null,
                        turn.metadata ? JSON.stringify(turn.metadata) : null,
                    ]
                );
            } catch (err) {
                log.warn('addTurn DB write failed', { sessionId, error: (err as Error).message });
            }
        })();
        return;
    }

    // No cache (edge case — process restart mid-call): original blocking behaviour
    const row = await queryOne<{ turn_count: number }>(
        `UPDATE public.conversation_sessions
            SET turn_count = turn_count + 1, updated_at = now()
          WHERE session_id = $1
          RETURNING turn_count`,
        [sessionId]
    );

    const turnNumber = row?.turn_count ?? 1;

    await query(
        `INSERT INTO public.conversation_turns
           (session_id, turn_number, role, content, intent, entities, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
        [
            sessionId,
            turnNumber,
            turn.role,
            turn.content,
            turn.intent ?? null,
            turn.entities ? JSON.stringify(turn.entities) : null,
            turn.metadata ? JSON.stringify(turn.metadata) : null,
        ]
    );
}

/**
 * Mark a session as ended.
 */
export async function endSession(sessionId: string): Promise<void> {
    _cache.delete(sessionId); // evict so stale state is never served to a new call
    await query(
        `UPDATE public.conversation_sessions
            SET ended_at = now(), state = 'COMPLETED', updated_at = now()
          WHERE session_id = $1`,
        [sessionId]
    );
    log.info('Session ended', { sessionId });
}

/**
 * Return the last N turns in ascending order (oldest first).
 * Fetches DESC then reverses so callers always get chronological order.
 */
export async function getRecentTurns(
    sessionId: string,
    limit = 20
): Promise<ConversationTurn[]> {
    // Cache hit — turns are already in-memory in chronological order
    const cached = _cache.get(sessionId);
    if (cached) return cached.turns.slice(-limit);

    // Cache miss — fallback to DB
    const rows = await queryMany<DBTurn>(
        `SELECT * FROM public.conversation_turns
          WHERE session_id = $1
          ORDER BY turn_number DESC
          LIMIT $2`,
        [sessionId, limit]
    );

    return rows.map(dbTurnToTurn).reverse();
}

/**
 * Build a Gemini-compatible message array for the LLM context window.
 * Automatically compresses context when turn_count > 20:
 *   - Prepends contextSummary as a system message
 *   - Then includes only the last 10 turns
 * This keeps token usage bounded on long calls.
 */
export async function buildLLMHistory(
    sessionId: string,
    maxTurns = 15
): Promise<{ role: 'user' | 'assistant' | 'system'; content: string }[]> {
    const session = await getSession(sessionId);
    if (!session) return [];

    let windowSize = maxTurns;
    const messages: { role: 'user' | 'assistant' | 'system'; content: string }[] = [];

    if (session.turnCount > 20 && session.contextSummary) {
        messages.push({
            role: 'system',
            content: `Conversation so far: ${session.contextSummary}`,
        });
        windowSize = 10;
    }

    // Use session.turns directly — already in memory (0ms if cache hit)
    const recentTurns = session.turns.slice(-windowSize);
    for (const t of recentTurns) {
        messages.push({ role: t.role, content: t.content });
    }

    return messages;
}

// ── Order persistence ─────────────────────────────────────────────────────────

/**
 * Persist a completed order in one atomic operation.
 * This is the ONLY place that writes to: orders, order_lines, inventory, customers.
 *
 * Steps:
 *   1. New customer? INSERT into customers first.
 *   2. INSERT order row.
 *   3. INSERT all order_lines.
 *   4. UPDATE inventory (decrement stock).
 *   5. UPDATE customer stats.
 *   6. Mark session as complete.
 */
export async function saveCompletedOrder(
    session: SessionContext
): Promise<{ orderId: string; success: boolean }> {
    const { cart, cartTotal, appliedDiscount, appliedOfferId, customer, language } = session;

    if (cart.length === 0) {
        log.warn('saveCompletedOrder called with empty cart', { sessionId: session.sessionId });
        return { orderId: '', success: false };
    }

    // Derive day part from current hour
    const hour = new Date().getHours();
    let dayPart = 'dinner';
    if (hour >= 6 && hour < 12) dayPart = 'breakfast';
    else if (hour >= 12 && hour < 16) dayPart = 'lunch';
    else if (hour >= 16 && hour < 19) dayPart = 'snacks';

    const netTotal = cartTotal - appliedDiscount;
    const restaurantIdNum = parseInt(session.restaurantId, 10) || 1;

    try {
        // ── Step 1: Ensure customer row exists ────────────────────────────────
        let customerId = customer.customerId;
        if (!customerId) {
            const newCust = await queryOne<{ id: number }>(
                `INSERT INTO public.customers
                   (restaurant_id, phone, name, segment, visit_count,
                    total_spent, avg_order_value, preferred_cuisine, last_visit_at, created_at)
                 VALUES ($1, $2, $3, 'NEW', 0, 0, 0, $4, now(), now())
                 ON CONFLICT (phone) DO UPDATE
                   SET name = EXCLUDED.name
                 RETURNING id`,
                [
                    restaurantIdNum,
                    session.customerPhone,
                    customer.customerName ?? 'Guest',
                    customer.preferredCuisine ?? null,
                ]
            );
            customerId = newCust?.id ?? null;
        }

        // ── Step 2: INSERT order ──────────────────────────────────────────────
        const orderRow = await queryOne<{ id: string }>(
            `INSERT INTO public.orders
               (restaurant_id, customer_id, status, total_amount, discount_amount,
                net_amount, day_part, language, applied_offer_id, session_id, created_at)
             VALUES ($1, $2, 'confirmed', $3, $4, $5, $6, $7, $8, $9, now())
             RETURNING id`,
            [
                restaurantIdNum,
                customerId,
                cartTotal,
                appliedDiscount,
                netTotal,
                dayPart,
                language,
                appliedOfferId,
                session.sessionId,
            ]
        );

        if (!orderRow?.id) throw new Error('Order INSERT returned no id');
        const orderId = orderRow.id;

        // ── Step 3: INSERT order_lines ─────────────────────────────────────────
        for (const item of cart) {
            await query(
                `INSERT INTO public.order_lines
                   (order_id, item_id, qty, unit_price, food_cost_snapshot,
                    is_upsold, modifier_delta, line_total)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                    orderId,
                    item.itemId,
                    item.qty,
                    item.unitPrice,
                    item.foodCost,
                    item.isUpsold,
                    item.modifiers.reduce((s, m) => s + m.priceDelta, 0),
                    item.lineTotal,
                ]
            );
        }

        // ── Step 4: Decrement inventory ───────────────────────────────────────
        for (const item of cart) {
            await query(
                `UPDATE public.inventory
                    SET current_remaining = GREATEST(0, current_remaining - $1),
                        updated_at = now()
                  WHERE item_id = $2 AND restaurant_id = $3`,
                [item.qty, item.itemId, restaurantIdNum]
            ).catch((err) =>
                log.warn('Inventory update failed (non-fatal)', {
                    itemId: item.itemId,
                    error: (err as Error).message,
                })
            );
        }

        // ── Step 5: Update customer stats ─────────────────────────────────────
        if (customerId) {
            await query(
                `UPDATE public.customers
                    SET visit_count    = visit_count + 1,
                        total_spent    = total_spent + $1,
                        avg_order_value = (total_spent + $1) / (visit_count + 1),
                        last_visit_at  = now(),
                        updated_at     = now()
                  WHERE id = $2`,
                [netTotal, customerId]
            ).catch((err) =>
                log.warn('Customer stats update failed (non-fatal)', {
                    customerId,
                    error: (err as Error).message,
                })
            );
        }

        // ── Step 6: Mark session as complete ──────────────────────────────────
        await updateSession(session.sessionId, {
            orderId,
            kotCreated: true,
            state: 'COMPLETED',
            netTotal,
            appliedDiscount,
            appliedOfferId,
        });

        log.info('Order saved', {
            orderId,
            sessionId: session.sessionId,
            customerId,
            cartItems: cart.length,
            netTotal,
        });

        return { orderId, success: true };
    } catch (err) {
        log.error('saveCompletedOrder failed', {
            sessionId: session.sessionId,
            error: (err as Error).message,
        });
        return { orderId: '', success: false };
    }
}
