import { createServiceLogger } from '../utils/logger'

const log = createServiceLogger('Embedder')

const MODEL = 'sentence-transformers/all-MiniLM-L6-v2'
const HF_URL = `https://api-inference.huggingface.co/pipeline/feature-extraction/${MODEL}`
const BATCH_SIZE = 32
const BATCH_DELAY_MS = 200

function getHfKey(): string {
  const key = process.env.HUGGINGFACE_API_KEY
  if (!key) throw new Error('HUGGINGFACE_API_KEY is not set')
  return key
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function embedText(text: string): Promise<number[]> {
  const apiKey = getHfKey()
  const body = JSON.stringify({ inputs: text, options: { wait_for_model: true } })

  const doRequest = async (): Promise<number[]> => {
    const res = await fetch(HF_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    })

    if (res.status === 503) {
      log.warn('HF model loading (503), retrying in 15s')
      await sleep(15_000)
      const retry = await fetch(HF_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
      })
      if (!retry.ok) {
        throw new Error(`HuggingFace API error after 503 retry: status ${retry.status}`)
      }
      return retry.json() as Promise<number[]>
    }

    if (res.status === 429) {
      log.warn('HF rate limited (429), retrying in 30s')
      await sleep(30_000)
      const retry = await fetch(HF_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
      })
      if (!retry.ok) {
        throw new Error(`HuggingFace API error after 429 retry: status ${retry.status}`)
      }
      return retry.json() as Promise<number[]>
    }

    if (!res.ok) {
      throw new Error(`HuggingFace API error: status ${res.status}`)
    }

    return res.json() as Promise<number[]>
  }

  return doRequest()
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const apiKey = getHfKey()
  const chunks: string[][] = []
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    chunks.push(texts.slice(i, i + BATCH_SIZE))
  }

  const results: number[][] = []
  let processed = 0

  for (const chunk of chunks) {
    const res = await fetch(HF_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inputs: chunk, options: { wait_for_model: true } }),
    })

    if (!res.ok) {
      throw new Error(`HuggingFace batch API error: status ${res.status}`)
    }

    const batch = (await res.json()) as number[][]
    results.push(...batch)
    processed += chunk.length
    log.info(`Embedded ${processed}/${texts.length} documents`)

    if (processed < texts.length) {
      await sleep(BATCH_DELAY_MS)
    }
  }

  return results
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0
  let dot = 0
  let magA = 0
  let magB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB)
  if (denom === 0) return 0
  return Math.min(1, Math.max(0, dot / denom))
}

export function dotProduct(a: number[], b: number[]): number {
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result += a[i] * b[i]
  }
  return result
}

export function normalizeVector(v: number[]): number[] {
  let magnitude = 0
  for (const x of v) magnitude += x * x
  magnitude = Math.sqrt(magnitude)
  if (magnitude === 0) return new Array(v.length).fill(0) as number[]
  return v.map((x) => x / magnitude)
}

export function normalizeVectors(vs: number[][]): number[][] {
  return vs.map(normalizeVector)
}

export async function embedAndNormalize(text: string): Promise<number[]> {
  const embedding = await embedText(text)
  return normalizeVector(embedding)
}

export async function embedBatchAndNormalize(texts: string[]): Promise<number[][]> {
  const embeddings = await embedBatch(texts)
  return normalizeVectors(embeddings)
}

// LRU query cache — avoids re-embedding same query within a session
const queryCache = new Map<string, number[]>()
const queryCacheOrder: string[] = []
const CACHE_MAX = 100

export async function embedQuery(query: string): Promise<number[]> {
  const normalized = query.toLowerCase().trim().replace(/\s+/g, ' ')

  if (queryCache.has(normalized)) {
    return queryCache.get(normalized)!
  }

  const embedding = await embedAndNormalize(normalized)

  if (queryCache.size >= CACHE_MAX) {
    const oldest = queryCacheOrder.shift()
    if (oldest) queryCache.delete(oldest)
  }

  queryCache.set(normalized, embedding)
  queryCacheOrder.push(normalized)

  return embedding
}

export function clearQueryCache(): void {
  queryCache.clear()
  queryCacheOrder.length = 0
}

export function getQueryCacheSize(): number {
  return queryCache.size
}
