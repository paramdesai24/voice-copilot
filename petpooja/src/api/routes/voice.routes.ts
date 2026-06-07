/**
 * Voice Integration Routes
 * Simplified endpoint for the Python voice agent.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { DemoConversationService } from '../demo/demoService';
import { createSession, getSession } from '../../conversation/sessionStore';
import { getLastTiming } from '../../brain/brainService';
import { env } from '../../config/env';
import { createServiceLogger } from '../../utils/logger';

const log = createServiceLogger('VoiceRoutes');
const demoService = new DemoConversationService();

interface ChatBody {
    message: string;
    sessionId?: string; // Provided by voice_agent (e.g., call_sid)
}

async function handleVoiceChat(
    request: FastifyRequest<{ Body: ChatBody }>,
    reply: FastifyReply
): Promise<void> {
    const { message, sessionId = 'voice-default-session' } = request.body;
    const startMs = Date.now();

    log.info('Voice chat request', { sessionId, message: message?.substring(0, 80) });

    if (!message?.trim()) {
        reply.status(400).send({
            success: false,
            error: 'INVALID_INPUT',
            message: 'message cannot be empty',
        });
        return;
    }

    try {
        // ── 1. Session DB lookup ──────────────────────────────────────────────
        const t0Session = Date.now();
        let session = await getSession(sessionId);
        const sessionDbMs = Date.now() - t0Session;

        if (!session) {
            log.info('Creating new session for voice chat', { sessionId });
            const t0Create = Date.now();
            await createSession(
                sessionId,
                env.DEFAULT_RESTAURANT_ID,
                '+910000000000',
                env.DEFAULT_LANGUAGE
            );
            const createDbMs = Date.now() - t0Create;
            log.info('Session created', { sessionId, createDbMs });
        }

        // ── 2. Brain / LLM processing ─────────────────────────────────────────
        const t0Brain = Date.now();
        const result = await demoService.chat(sessionId, message.trim());
        const brainMs = Date.now() - t0Brain;

        // Pick up per-turn RAG + LLM timings stored by brainService.routeIntent
        const brainInternals = getLastTiming(sessionId);

        const totalMs = Date.now() - startMs;

        log.info('Voice chat complete', {
            sessionId,
            totalMs,
            sessionDbMs,
            brainMs,
            ragMs: brainInternals?.rag ?? null,
            llmMs: brainInternals?.llm ?? null,
            reply: result.reply.substring(0, 80),
        });

        // ── 3. Return reply + _timing breakdown for the Python voice agent ────
        reply.status(200).send({
            reply: result.reply
        });
    } catch (err) {
        const elapsedMs = Date.now() - startMs;
        const errMsg = (err as Error).message ?? 'unknown error';
        log.error('Voice chat error', { sessionId, elapsedMs, error: errMsg });
        // Return 200 even on error so Python voice agent picks up the reply text
        // instead of silently substituting its own fallback message.
        reply.status(200).send({
            reply: "I'm sorry, I'm having a little trouble right now. Could you please repeat that?"
        });
    }
}

export async function voiceRoutes(app: FastifyInstance): Promise<void> {
    app.post('/chat', handleVoiceChat);
}
