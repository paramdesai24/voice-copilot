/**
 * Customer Retriever
 * Looks up a customer by name from the pre-indexed RAG vector store.
 * No live DB reads — all data was embedded at index-build time.
 *
 * Lookup strategy:
 *   1. Extract customer name from spoken text
 *   2. O(N) scan of customer_profile docs matching metadata.customerNameNormalized
 *   3. If direct match found, fetch greeting + cuisine_offer docs
 *   4. Fallback to embedding search (minScore 0.6) if no direct match
 */

import { createServiceLogger } from '../../utils/logger'
import { getByType, getById, search } from '../vectorStore'
import { embedQuery } from '../embedder'
import type { RagDocument } from '../types'

const log = createServiceLogger('CustomerRetriever')

// ── Public types ──────────────────────────────────────────────────────────────

export interface CustomerLookupResult {
  found: boolean
  profileDoc: RagDocument | null
  greetingDoc: RagDocument | null
  cuisineOfferDoc: RagDocument | null
  customerName: string | null
  phone: string | null
  segment: 'LOYAL' | 'REGULAR' | 'NEW' | null
  visitCount: number
  preferredCuisine: string | null
  lastOrderItems: string[]
  daysSinceLastVisit: number | null
  avgOrderValue: number
  isNew: boolean
  isLoyal: boolean
}

const NOT_FOUND: CustomerLookupResult = {
  found: false,
  profileDoc: null,
  greetingDoc: null,
  cuisineOfferDoc: null,
  customerName: null,
  phone: null,
  segment: null,
  visitCount: 0,
  preferredCuisine: null,
  lastOrderItems: [],
  daysSinceLastVisit: null,
  avgOrderValue: 0,
  isNew: true,
  isLoyal: false,
}

// ── Name extraction ──────────────────────────────────────────────────────────

/**
 * Extract a customer name from speech like "I am Ravi" / "mera naam Priya hai".
 */
export function extractNameFromSpeech(text: string): string | null {
  if (!text) return null

  const patterns = [
    /(?:i am|i'm|my name is|naam hai|mera naam|this is)\s+([A-Za-z]+)/i,
    /^([A-Za-z]{3,20})\s+(?:here|speaking|calling)/i,
    /(?:bola|bole|bataya)\s+([A-Za-z]+)/i,
  ]

  for (const re of patterns) {
    const m = text.match(re)
    if (m?.[1] && m[1].length >= 2) {
      return m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()
    }
  }

  return null
}

// ── Direct scan ───────────────────────────────────────────────────────────────

function scanForName(name: string): RagDocument | null {
  const normalizedInput = name.toLowerCase().trim()
  const profileDocs = getByType('customer_profile')
  for (const doc of profileDocs) {
    // Try normalized full-name match first
    const docNameNorm = ((doc.metadata.customerNameNormalized as string | undefined) ?? '').trim()
    if (docNameNorm && docNameNorm === normalizedInput) return doc
    // First-name fallback (min 3 chars to avoid false positives)
    const docFirst = docNameNorm.split(' ')[0]
    const inputFirst = normalizedInput.split(' ')[0]
    if (docFirst.length >= 3 && inputFirst.length >= 3 && docFirst === inputFirst) return doc
  }
  return null
}

function getCompanionDocs(
  customerId: number
): { greetingDoc: RagDocument | null; cuisineOfferDoc: RagDocument | null } {
  return {
    greetingDoc: getById(`customer_greeting_${customerId}`) ?? null,
    cuisineOfferDoc: getById(`customer_cuisine_offer_${customerId}`) ?? null,
  }
}

function buildResult(
  profileDoc: RagDocument,
  greetingDoc: RagDocument | null,
  cuisineOfferDoc: RagDocument | null
): CustomerLookupResult {
  const m = profileDoc.metadata
  return {
    found: true,
    profileDoc,
    greetingDoc,
    cuisineOfferDoc,
    customerName: (m.customerName as string | null) ?? null,
    phone: (m.customerPhone as string | null) ?? null,
    segment: (m.segment as 'LOYAL' | 'REGULAR' | 'NEW' | null) ?? null,
    visitCount: (m.visitCount as number | undefined) ?? 0,
    preferredCuisine: (m.preferredCuisine as string | null) ?? null,
    lastOrderItems: (m.lastOrderItems as string[] | undefined) ?? [],
    daysSinceLastVisit: (m.daysSinceLastVisit as number | null) ?? null,
    avgOrderValue: (m.avgOrderValue as number | undefined) ?? 0,
    isNew: (m.isNew as boolean | undefined) ?? false,
    isLoyal: (m.isLoyal as boolean | undefined) ?? false,
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Look up a customer by name extracted from the spoken transcript.
 * Returns NOT_FOUND shape if no match.
 */
export async function lookupCustomerByName(
  spokenText: string
): Promise<CustomerLookupResult> {
  // Step 1: Extract name from speech
  const name = extractNameFromSpeech(spokenText)
  if (!name) {
    log.debug('No name found in speech', { text: spokenText.slice(0, 80) })
    return NOT_FOUND
  }

  log.debug('Extracted name from speech', { name })

  // Step 2: Direct O(N) scan of customer_profile docs
  const profileDoc = scanForName(name)
  if (profileDoc) {
    const customerId = profileDoc.metadata.customerId as number
    const { greetingDoc, cuisineOfferDoc } = getCompanionDocs(customerId)
    log.info('Customer found via direct scan', {
      customerId,
      name: profileDoc.metadata.customerName,
      segment: profileDoc.metadata.segment,
    })
    return buildResult(profileDoc, greetingDoc, cuisineOfferDoc)
  }

  // Step 3: Embedding fallback — search for the name as a query
  log.debug('Direct scan missed — falling back to embedding search', { name })
  try {
    const queryText = `customer name ${name}`
    const queryEmbedding = await embedQuery(queryText)
    const results = search(queryEmbedding, {
      types: ['customer_profile'],
      topK: 3,
      minScore: 0.6,
    })

    if (results.length > 0) {
      const bestDoc = results[0].document
      const customerId = bestDoc.metadata.customerId as number
      const { greetingDoc, cuisineOfferDoc } = getCompanionDocs(customerId)
      log.info('Customer found via embedding fallback', {
        customerId,
        score: results[0].score,
      })
      return buildResult(bestDoc, greetingDoc, cuisineOfferDoc)
    }
  } catch (err) {
    log.warn('Embedding search for customer failed', { error: (err as Error).message })
  }

  log.debug('Customer not found', { name })
  return NOT_FOUND
}
