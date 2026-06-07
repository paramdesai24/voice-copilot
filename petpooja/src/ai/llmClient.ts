/**
 * LLM Client
 * Abstraction layer over OpenAI (and Gemini-compatible) APIs.
 * Provides typed, retry-aware methods for each prompt type.
 * All responses are validated against expected JSON schemas.
 */

import OpenAI from 'openai';
import { env } from '../config/env';
import { createServiceLogger } from '../utils/logger';
import { LLMError, ErrorCode } from '../utils/errors';
import { extractJSON, stripCodeFences, sleep } from '../utils/helpers';
import {
    MenuItem,
    OrderItem,
    SupportedLanguage,
    LLMOrderExtractionResult,
    LLMUpsellResult,
    LLMConfirmationResult,
    LLMClarificationResult,
} from '../types';
import {
    buildSystemPrompt,
    buildOrderExtractionPrompt,
    buildUpsellPrompt,
    buildConfirmationPrompt,
    buildClarificationPrompt,
    buildGreetingPrompt,
    buildRetryPrompt,
    buildGoodbyePrompt,
    buildQueryResponsePrompt,
    buildSmallTalkPrompt,
} from './promptTemplates';

const log = createServiceLogger('LLMClient');

// ── OpenAI client singleton ───────────────────────────────────────────────────
let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
    if (!openaiClient) {
        openaiClient = new OpenAI({
            apiKey: env.OPENAI_API_KEY,
            baseURL: env.OPENAI_BASE_URL || undefined,
            timeout: 8_000,   // 8s — fail fast for voice; retry handles transient errors
            maxRetries: 0,    // disable built-in retries; withLLMRetry handles that
        });
    }
    return openaiClient;
}

// ── Core chat completion helper ───────────────────────────────────────────────
interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

interface LLMCallOptions {
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
}

async function callLLM(
    messages: ChatMessage[],
    options: LLMCallOptions = {}
): Promise<string> {
    const {
        temperature = env.OPENAI_TEMPERATURE,
        maxTokens = env.OPENAI_MAX_TOKENS,
        jsonMode = true,
    } = options;

    const startTime = Date.now();

    try {
        const response = await getOpenAIClient().chat.completions.create({
            model: env.OPENAI_MODEL,
            messages,
            temperature,
            max_tokens: maxTokens,
            response_format: jsonMode ? { type: 'json_object' } : { type: 'text' },
        });

        const latencyMs = Date.now() - startTime;
        log.debug('LLM call completed', {
            model: env.OPENAI_MODEL,
            latencyMs,
            tokens: response.usage?.total_tokens,
        });

        // Warn if latency exceeds target
        if (latencyMs > 1500) {
            log.warn('LLM latency exceeded 1.5s target', { latencyMs });
        }

        const content = response.choices[0]?.message?.content;
        if (!content) {
            throw new LLMError('Empty response from LLM', ErrorCode.LLM_INVALID_RESPONSE);
        }

        return content;
    } catch (err) {
        const latencyMs = Date.now() - startTime;
        log.error('LLM call failed', {
            error: (err as Error).message,
            latencyMs,
        });

        if (err instanceof LLMError) throw err;

        // Map OpenAI errors to our error types
        const message = (err as Error).message || 'LLM request failed';
        if (message.includes('timeout') || message.includes('ETIMEDOUT')) {
            throw new LLMError('LLM request timed out', ErrorCode.LLM_UNAVAILABLE);
        }

        throw new LLMError(message, ErrorCode.LLM_UNAVAILABLE);
    }
}

/**
 * Parse and validate JSON from an LLM response string.
 * Handles code fences and extracts JSON blocks.
 */
function parseLLMJson<T>(raw: string, context: string): T {
    const cleaned = stripCodeFences(raw);
    const parsed = extractJSON<T>(cleaned);

    if (!parsed) {
        log.error('Failed to parse LLM JSON', { raw: raw.slice(0, 500), context });
        throw new LLMError(
            `LLM returned invalid JSON for: ${context}`,
            ErrorCode.LLM_INVALID_RESPONSE
        );
    }

    return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract order items from a speech transcript.
 */
export async function extractOrderFromTranscript(
    transcript: string,
    menuItems: MenuItem[],
    restaurantName: string,
    language: SupportedLanguage,
    conversationHistory: ChatMessage[] = []
): Promise<LLMOrderExtractionResult> {
    const messages: ChatMessage[] = [
        { role: 'system', content: buildSystemPrompt(restaurantName, menuItems) },
        ...conversationHistory,
        {
            role: 'user',
            content: buildOrderExtractionPrompt(transcript, menuItems, language),
        },
    ];

    const raw = await callLLM(messages, { temperature: 0.1 });
    const result = parseLLMJson<LLMOrderExtractionResult>(raw, 'order_extraction');

    log.info('Order extracted', {
        intent: result.intent,
        itemCount: result.items.length,
        queryText: result.query_text,
        language: result.language_detected,
        needsClarification: result.needs_clarification,
        unrecognized: result.unrecognized_items,
    });

    return result;
}

/**
 * Convert a NL→SQL query result into a natural spoken response.
 */
export async function generateQueryResponse(
    queryText: string,
    sqlResultText: string,
    language: SupportedLanguage
): Promise<string> {
    const messages: ChatMessage[] = [
        {
            role: 'user',
            content: buildQueryResponsePrompt(queryText, sqlResultText, language),
        },
    ];

    const raw = await callLLM(messages, { temperature: 0.3, maxTokens: 300 });
    const result = parseLLMJson<{ response_text: string }>(raw, 'query_response');
    return result.response_text;
}

/**
 * Generate a friendly deflection for smalltalk, redirecting back to ordering.
 */
export async function generateSmallTalkResponse(
    transcript: string,
    restaurantName: string,
    language: SupportedLanguage
): Promise<string> {
    const messages: ChatMessage[] = [
        {
            role: 'user',
            content: buildSmallTalkPrompt(transcript, restaurantName, language),
        },
    ];

    const raw = await callLLM(messages, { temperature: 0.5, maxTokens: 300, jsonMode: false });
    try {
        const result = parseLLMJson<{ response_text: string }>(raw, 'smalltalk');
        return result.response_text;
    } catch {
        // Fallback: strip fences and return raw
        return stripCodeFences(raw).trim();
    }
}

/**
 * Generate an upsell suggestion message.
 */
export async function generateUpsellSuggestion(
    currentItems: OrderItem[],
    suggestedItems: MenuItem[],
    language: SupportedLanguage
): Promise<LLMUpsellResult> {
    const messages: ChatMessage[] = [
        {
            role: 'user',
            content: buildUpsellPrompt(currentItems, suggestedItems, language),
        },
    ];

    const raw = await callLLM(messages, { temperature: 0.3 });
    return parseLLMJson<LLMUpsellResult>(raw, 'upsell');
}

/**
 * Generate an order confirmation readback message.
 */
export async function generateOrderConfirmation(
    items: OrderItem[],
    totalAmount: number,
    language: SupportedLanguage
): Promise<LLMConfirmationResult> {
    const messages: ChatMessage[] = [
        {
            role: 'user',
            content: buildConfirmationPrompt(items, totalAmount, language),
        },
    ];

    const raw = await callLLM(messages, { temperature: 0.2, maxTokens: 300 });
    return parseLLMJson<LLMConfirmationResult>(raw, 'confirmation');
}

/**
 * Generate a clarification question for an ambiguous item.
 */
export async function generateClarification(
    ambiguousText: string,
    candidates: MenuItem[],
    language: SupportedLanguage
): Promise<LLMClarificationResult> {
    const messages: ChatMessage[] = [
        {
            role: 'user',
            content: buildClarificationPrompt(ambiguousText, candidates, language),
        },
    ];

    const raw = await callLLM(messages, { temperature: 0.2, maxTokens: 300 });
    return parseLLMJson<LLMClarificationResult>(raw, 'clarification');
}

/**
 * Generate a greeting message.
 */
export async function generateGreeting(
    restaurantName: string,
    language: SupportedLanguage
): Promise<string> {
    const messages: ChatMessage[] = [
        {
            role: 'user',
            content: buildGreetingPrompt(restaurantName, language),
        },
    ];

    const raw = await callLLM(messages, { temperature: 0.4, maxTokens: 200 });
    const result = parseLLMJson<{ greeting_text: string }>(raw, 'greeting');
    return result.greeting_text;
}

/**
 * Generate a retry / did-not-understand message.
 */
export async function generateRetryMessage(
    language: SupportedLanguage,
    attemptNumber: number
): Promise<string> {
    const messages: ChatMessage[] = [
        {
            role: 'user',
            content: buildRetryPrompt(language, attemptNumber),
        },
    ];

    const raw = await callLLM(messages, { temperature: 0.3, maxTokens: 150 });
    const result = parseLLMJson<{ retry_text: string }>(raw, 'retry');
    return result.retry_text;
}

/**
 * Generate a goodbye / order-confirmed message.
 */
export async function generateGoodbye(
    kotNumber: string | undefined,
    language: SupportedLanguage
): Promise<string> {
    const messages: ChatMessage[] = [
        {
            role: 'user',
            content: buildGoodbyePrompt(kotNumber, language),
        },
    ];

    const raw = await callLLM(messages, { temperature: 0.4, maxTokens: 200 });
    const result = parseLLMJson<{ goodbye_text: string }>(raw, 'goodbye');
    return result.goodbye_text;
}

/**
 * Generic LLM response — returns raw text (not JSON-parsed).
 * Used by the new Brain v3 state machine for intent-routed prompts.
 */
export async function generateLLMResponse(
    prompt: string,
    history: { role: 'user' | 'assistant' | 'system'; content: string }[] = []
): Promise<string> {
    const messages: ChatMessage[] = [
        ...history,
        { role: 'user', content: prompt },
    ];
    return callLLM(messages, { temperature: 0.2, maxTokens: 400, jsonMode: false });
}

/**
 * Retry wrapper: Attempt an LLM call up to maxAttempts times with backoff.
 */
export async function withLLMRetry<T>(
    fn: () => Promise<T>,
    maxAttempts = 2  // 2 attempts for voice — fail fast rather than blocking the caller
): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err as Error;
            log.warn(`LLM attempt ${attempt}/${maxAttempts} failed`, {
                error: (err as Error).message,
            });
            if (attempt < maxAttempts) {
                await sleep(300); // 300ms only — keeps voice latency low
            }
        }
    }

    throw lastError;
}
