/**
 * Brain Service v3
 * RAG-first conversation engine.
 * - All data comes from the pre-indexed vector store during a call.
 * - saveCompletedOrder() is the ONLY DB write â€” one transaction at confirmation.
 * - State machine: IDENTITY_COLLECTION â†’ GREETING â†’ COLLECTING_ORDER â†’ AWAITING_CONFIRMATION â†’ COMPLETED
 */

import { createServiceLogger } from '../utils/logger';
import {
    createSession,
    getSession,
    updateSession,
    addTurn,
    applyToCache,
    pushSystemTurn,
    buildLLMHistory,
    saveCompletedOrder,
    SessionContext,
    CartItem,
} from '../conversation/sessionStore';
import { summarizeHistory } from './contextSummarizer';
import { retrieveForIntent } from '../rag/ragService';
import { lookupCustomerByName, extractNameFromSpeech } from '../rag/retrievers/customerRetriever';
import {
    getUpsellSuggestion,
    getOfferNudge,
    computeOfferDiscount,
    buildUpsellLine,
    UpsellSuggestion,
} from '../upsell/recommendationEngine';
import { generateLLMResponse } from '../ai/llmClient';
import {
    BRAIN_SYSTEM_PROMPT,
    buildTurnPrompt,
    buildIntentExtractionPrompt,
} from '../ai/promptTemplates';
import {
    addToCart,
    removeFromCart,
    modifyCartItem,
    cartTotal as computeCartTotal,
    parseLLMOrderResult,
    buildOutput,
    getConfirmationReprompt,
    buildCartSummary,
    BrainOutput,
} from './cartHelpers';

export type { BrainOutput };

const log = createServiceLogger('BrainService');

// â”€â”€ Public input type â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface BrainInput {
    sessionId: string;
    transcript: string;
    restaurantId: number;
    detectedLanguage?: string;
    isVoiceCall: boolean;
}

// â”€â”€ Signal lists â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const END_OF_CALL_SIGNALS: Record<string, string[]> = {
    en: ['bye', 'goodbye', 'hang up', 'end call', 'that\'s all', 'thats all', 'i\'m done', 'im done', 'nothing else', 'no thanks'],
    hi: ['à¤¬à¤‚à¤¦ à¤•à¤°à¥‹', 'à¤¬à¤¾à¤¯', 'à¤¬à¤¸', 'à¤ à¥€à¤• à¤¹à¥ˆ à¤¬à¤¸', 'à¤§à¤¨à¥à¤¯à¤µà¤¾à¤¦ à¤¬à¤¾à¤¯'],
    hinglish: ['bas', 'bye kar', 'done hai', 'khatam', 'thats it'],
}

const YES_SIGNALS = ['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'haan', 'ji haan', 'ji', 'bilkul', 'confirm', 'theek hai', 'correct', 'right', 'perfect', 'done', 'go ahead', 'place order', 'order karo', 'order kar do']
const NO_SIGNALS  = ['no', 'nope', 'nahi', 'na', 'naa', 'cancel', 'modify', 'change', 'wait', 'hold on', 'ruko', 'baad mein']

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function detectLanguage(text: string, hint?: string): string {
    if (hint && ['en', 'hi', 'hinglish'].includes(hint)) return hint;
    const devanagari = /[\u0900-\u097F]/.test(text);
    if (devanagari) return 'hi';
    const hinglishWords = /\b(kya|hai|haan|nahi|bhai|yaar|aur|mera|tera|karo|lena|dena|chahiye)\b/i.test(text);
    if (hinglishWords) return 'hinglish';
    return 'en';
}

function isEndOfCallSignal(text: string, lang: string): boolean {
    const lower = text.toLowerCase();
    const signals = [
        ...(END_OF_CALL_SIGNALS[lang] ?? []),
        ...END_OF_CALL_SIGNALS['en'],
    ];
    return signals.some((s) => lower.includes(s));
}

function isYesSignal(text: string): boolean {
    const lower = text.toLowerCase().trim();
    return YES_SIGNALS.some((s) => lower.includes(s));
}

function isNoSignal(text: string): boolean {
    const lower = text.toLowerCase().trim();
    return NO_SIGNALS.some((s) => lower.includes(s));
}

function endCallResponse(lang: string): string {
    if (lang === 'hi') return 'à¤†à¤ªà¤•à¤¾ à¤¬à¤¹à¥à¤¤ à¤§à¤¨à¥à¤¯à¤µà¤¾à¤¦! à¤œà¤²à¥à¤¦à¥€ à¤®à¤¿à¤²à¥‡à¤‚à¤—à¥‡à¥¤';
    if (lang === 'hinglish') return 'Shukriya! Phir milenge.';
    return 'Thank you for calling Tadka & Twist! Goodbye.';
}

// â”€â”€ Intent extraction â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface IntentResult {
    intent: string;
    entities: {
        item_name?: string | null;
        qty?: number | null;
        modifier?: string | null;
        query_subject?: string | null;
    };
    confidence: number;
    language: string;
}

async function extractIntent(
    transcript: string,
    history: { role: string; content: string }[],
    language: string
): Promise<IntentResult> {
    const prompt = buildIntentExtractionPrompt(transcript, history, language);
    const raw = await generateLLMResponse(prompt, []);

    try {
        const parsed = JSON.parse(raw) as Partial<IntentResult>;
        return {
            intent: parsed.intent ?? 'UNKNOWN',
            entities: parsed.entities ?? {},
            confidence: parsed.confidence ?? 0.5,
            language: parsed.language ?? language,
        };
    } catch {
        log.warn('Intent extraction JSON parse failed â€” using UNKNOWN', { raw: raw.slice(0, 200) });
        return { intent: 'UNKNOWN', entities: {}, confidence: 0.3, language };
    }
}

// â”€â”€ State: IDENTITY_COLLECTION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function handleIdentityCollection(
    session: SessionContext,
    transcript: string
): Promise<BrainOutput> {
    const lang = session.language;

    // Try to extract name from this turn
    const name = extractNameFromSpeech(transcript);

    if (name) {
        // Lookup customer in RAG by name
        const lookup = await lookupCustomerByName(transcript);

        const customer: SessionContext['customer'] = {
            customerId: lookup.found ? lookup.profileDoc?.metadata.customerId as number ?? null : null,
            customerName: lookup.customerName ?? name,
            customerPhone: (lookup.found ? lookup.phone : null) ?? '',
            segment: lookup.segment,
            visitCount: lookup.visitCount,
            avgOrderValue: lookup.avgOrderValue,
            preferredCuisine: lookup.preferredCuisine,
            lastOrderItems: lookup.lastOrderItems,
            daysSinceLastVisit: lookup.daysSinceLastVisit,
            isReturning: !lookup.isNew,
            isNew: lookup.isNew,
        };

        // Determine greeting
        let responseText: string;
        const greetingMeta = lookup.greetingDoc?.metadata;
        if (greetingMeta) {
            responseText =
                lang === 'hi' ? (greetingMeta.greetingHi as string)
                : lang === 'hinglish' ? (greetingMeta.greetingHinglish as string)
                : (greetingMeta.greetingEn as string);
        } else if (lookup.found && lookup.customerName) {
            if (lang === 'hi') responseText = `à¤µà¤¾à¤ªà¤¸ à¤†à¤¨à¥‡ à¤•à¤¾ à¤¸à¥à¤µà¤¾à¤—à¤¤ à¤¹à¥ˆ, ${lookup.customerName}! à¤†à¤œ à¤•à¥à¤¯à¤¾ à¤²à¥‡à¤‚à¤—à¥‡?`;
            else if (lang === 'hinglish') responseText = `Welcome back, ${lookup.customerName}! Kya lena hai aaj?`;
            else responseText = `Welcome back, ${lookup.customerName}! What would you like today?`;
        } else {
            if (lang === 'hi') responseText = 'à¤¨à¤®à¤¸à¥à¤¤à¥‡! Tadka & Twist à¤®à¥‡à¤‚ à¤†à¤ªà¤•à¤¾ à¤¸à¥à¤µà¤¾à¤—à¤¤ à¤¹à¥ˆà¥¤ à¤†à¤œ à¤•à¥à¤¯à¤¾ à¤‘à¤°à¥à¤¡à¤° à¤•à¤°à¤¨à¤¾ à¤¹à¥ˆ?';
            else if (lang === 'hinglish') responseText = 'Namaste! Tadka & Twist mein welcome. Kya khaoge aaj?';
            else responseText = "Welcome to Tadka & Twist! What would you like to order today?";
        }

        // Check if we should offer their usual cuisine
        let awaitingCuisineChoice = false;
        const cuisineOfferMeta = lookup.cuisineOfferDoc?.metadata;
        if (cuisineOfferMeta && lookup.visitCount >= 2 && lookup.lastOrderItems.length > 0) {
            const offerLine =
                lang === 'hi' ? (cuisineOfferMeta.offerHi as string)
                : lang === 'hinglish' ? (cuisineOfferMeta.offerHinglish as string)
                : (cuisineOfferMeta.offerEn as string);
            responseText += ' ' + offerLine;
            awaitingCuisineChoice = true;
        }

        // Persist customer to session (fire-and-forget)
        void updateSession(session.sessionId, {
            customer,
            state: 'COLLECTING_ORDER',
            language: lang,
            awaitingCuisineChoice,
        }).catch((err) => log.warn('Customer session save failed', { error: (err as Error).message }));

        session.customer = customer;
        session.state = 'COLLECTING_ORDER';
        session.awaitingCuisineChoice = awaitingCuisineChoice;

        return buildOutput(session, responseText, 'IDENTITY', 'COLLECTING_ORDER', null, null);
    }

    // No name found — ask for it
    let responseText: string;
    if (lang === 'hi') responseText = 'नमस्ते! क्या आप अपना नाम बता सकते हैं?';
    else if (lang === 'hinglish') responseText = 'Namaste! Apna naam bata sakte ho?';
    else responseText = 'Welcome to Tadka & Twist! Could I get your name?';

    return buildOutput(session, responseText, 'IDENTITY', 'IDENTITY_COLLECTION', null, null);
}

// â”€â”€ State: AWAITING_CONFIRMATION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function handleConfirmationResponse(
    session: SessionContext,
    transcript: string
): Promise<BrainOutput> {
    const lang = session.language;

    if (isYesSignal(transcript)) {
        return handleFinalConfirmation(session);
    }

    if (isNoSignal(transcript)) {
        // Customer wants to modify â€” go back to collecting
        void updateSession(session.sessionId, { awaitingOrderConfirmation: false, state: 'COLLECTING_ORDER' })
            .catch((err) => log.warn('State update failed', { error: (err as Error).message }));

        const responseText =
            lang === 'hi' ? 'à¤ à¥€à¤• à¤¹à¥ˆ! à¤†à¤ª à¤•à¥à¤¯à¤¾ à¤¬à¤¦à¤²à¤¨à¤¾ à¤šà¤¾à¤¹à¤¤à¥‡ à¤¹à¥ˆà¤‚?'
            : lang === 'hinglish' ? 'Theek hai! Kya change karna hai?'
            : 'No problem! What would you like to change?';

        return buildOutput(session, responseText, 'CANCEL_CONFIRM', 'COLLECTING_ORDER', null, null);
    }

    // Ambiguous â€” reprompt
    const responseText = getConfirmationReprompt(lang);
    return buildOutput(session, responseText, 'CONFIRM_REPROMPT', 'AWAITING_CONFIRMATION', null, null);
}

async function handleFinalConfirmation(session: SessionContext): Promise<BrainOutput> {
    const lang = session.language;
    const discount = computeOfferDiscount(session.cartTotal);
    const discountAmt = discount?.discountAmt ?? 0;
    const offerId = discount?.offerId ?? null;
    const net = session.cartTotal - discountAmt;

    // Apply discount to cart items
    const finalSession: SessionContext = {
        ...session,
        appliedDiscount: discountAmt,
        appliedOfferId: offerId,
        netTotal: net,
    };

    const result = await saveCompletedOrder(finalSession);

    if (result.success) {
        const cartSummary = buildCartSummary(session.cart, session.cartTotal, discountAmt, net, lang);
        let responseText: string;

        if (lang === 'hi') {
            responseText = `à¤¬à¤¢à¤¼à¤¿à¤¯à¤¾! à¤†à¤ªà¤•à¤¾ à¤‘à¤°à¥à¤¡à¤° à¤•à¤¨à¥à¤«à¤°à¥à¤® à¤¹à¥‹ à¤—à¤¯à¤¾à¥¤ ${discount ? `â‚¹${discountAmt} à¤•à¥€ à¤›à¥‚à¤Ÿ à¤•à¥‡ à¤¸à¤¾à¤¥ à¤†à¤ªà¤•à¤¾ à¤•à¥à¤² â‚¹${net.toFixed(0)} à¤¹à¥ˆà¥¤ ` : ''}à¤§à¤¨à¥à¤¯à¤µà¤¾à¤¦!`;
        } else if (lang === 'hinglish') {
            responseText = `Zabardast! Order confirm ho gaya. ${discount ? `â‚¹${discountAmt} discount ke saath aapka total â‚¹${net.toFixed(0)} hai. ` : ''}Shukriya!`;
        } else {
            responseText = `Your order is confirmed! ${discount ? `You saved â‚¹${discountAmt} â€” final total â‚¹${net.toFixed(0)}. ` : `Total: â‚¹${session.cartTotal.toFixed(0)}. `}Thank you for ordering from Tadka & Twist!`;
        }

        void updateSession(session.sessionId, {
            state: 'COMPLETED',
            callEnded: true,
            appliedDiscount: discountAmt,
            appliedOfferId: offerId,
            netTotal: net,
        }).catch((err) => log.warn('Final session update failed', { error: (err as Error).message }));

        return buildOutput(
            finalSession, responseText, 'CONFIRM_ORDER', 'COMPLETED',
            null, null,
            session.cart, session.cartTotal, net, discountAmt, offerId,
            true, true, true, result.orderId
        );
    }

    // Order save failed
    const errText =
        lang === 'hi' ? 'à¤®à¤¾à¤«à¤¼ à¤•à¤°à¥‡à¤‚, à¤•à¥à¤› à¤¤à¤•à¤¨à¥€à¤•à¥€ à¤¸à¤®à¤¸à¥à¤¯à¤¾ à¤† à¤—à¤ˆà¥¤ à¤•à¥ƒà¤ªà¤¯à¤¾ à¤¦à¥‹à¤¬à¤¾à¤°à¤¾ à¤•à¥‹à¤¶à¤¿à¤¶ à¤•à¤°à¥‡à¤‚à¥¤'
        : lang === 'hinglish' ? 'Sorry, kuch technical problem hai. Please try again.'
        : 'Sorry, there was a technical issue placing your order. Please try again.';

    return buildOutput(session, errText, 'CONFIRM_FAIL', 'COLLECTING_ORDER', null, null);
}

// â”€â”€ State: AWAITING_CUISINE_CHOICE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function handleCuisineChoiceResponse(
    session: SessionContext,
    transcript: string
): Promise<BrainOutput> {
    const lang = session.language;

    void updateSession(session.sessionId, { awaitingCuisineChoice: false, state: 'COLLECTING_ORDER' })
        .catch((err) => log.warn('Cuisine choice state update failed', { error: (err as Error).message }));

    if (isYesSignal(transcript)) {
        // Add their usual items from RAG
        const items = session.customer.lastOrderItems;
        const lang = session.language;
        const responseText =
            items.length > 0
                ? lang === 'hi' ? `à¤¬à¤¢à¤¼à¤¿à¤¯à¤¾! ${items.join(', ')} à¤œà¥‹à¤¡à¤¼à¤¨à¥‡ à¤•à¥€ à¤•à¥‹à¤¶à¤¿à¤¶ à¤•à¤° à¤°à¤¹à¤¾ à¤¹à¥‚à¤à¥¤ à¤°à¥à¤•à¤¿à¤à¥¤`
                : lang === 'hinglish' ? `Theek hai! ${items.join(', ')} add karta hoon. Ek second.`
                : `Great! Let me add your usual â€” ${items.join(', ')} â€” to your order.`
                : lang === 'hi' ? 'à¤œà¤¼à¤°à¥‚à¤°! à¤•à¥à¤¯à¤¾ à¤‘à¤°à¥à¤¡à¤° à¤•à¤°à¤¨à¤¾ à¤¹à¥ˆ à¤¬à¤¤à¤¾à¤‡à¤à¥¤'
                : 'Sure! Go ahead and tell me what you\'d like.';

        // We can't auto-add from voice since we don't have itemIds here â€” ask LLM to handle
        return buildOutput(session, responseText, 'CUISINE_YES', 'COLLECTING_ORDER', null, null);
    }

    // Customer declined usual â€” continue normally
    const responseText =
        lang === 'hi' ? 'à¤ à¥€à¤• à¤¹à¥ˆ! à¤†à¤œ à¤•à¥à¤¯à¤¾ à¤‘à¤°à¥à¤¡à¤° à¤•à¤°à¤¨à¤¾ à¤¹à¥ˆ?'
        : lang === 'hinglish' ? 'Theek hai! Aaj kya lena hai?'
        : 'No problem! What would you like to order today?';

    return buildOutput(session, responseText, 'CUISINE_NO', 'COLLECTING_ORDER', null, null);
}

// â”€â”€ Main intent router â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function routeIntent(
    session: SessionContext,
    transcript: string,
    intent: string,
    entities: IntentResult['entities'],
    history: { role: 'user' | 'assistant' | 'system'; content: string }[]
): Promise<BrainOutput> {
    const lang = session.language;

    // Get RAG context for this intent
    const ragCtx = await retrieveForIntent(
        intent,
        transcript,
        session.cart.map((i: CartItem) => i.itemId),
        session.cartTotal
    );
    const ragContent = ragCtx.topContent || '';

    // System message + turn prompt
    const systemMsg = BRAIN_SYSTEM_PROMPT(session);
    const turnPrompt = buildTurnPrompt(intent, transcript, session, ragContent, entities);

    const fullHistory: { role: 'user' | 'assistant' | 'system'; content: string }[] = [
        { role: 'system', content: systemMsg },
        ...history.filter((m) => m.role !== 'system'),
    ];

    const llmRaw = await generateLLMResponse(turnPrompt, fullHistory);
    const parsed = parseLLMOrderResult(llmRaw);

    let updatedCart = [...session.cart];
    let nextState = 'COLLECTING_ORDER';
    let upsellSuggestion: UpsellSuggestion | null = null;
    let offerNudgeLine: string | null = null;
    let responseText = parsed.responseText;

    switch (intent) {
        case 'ORDER_ADD': {
            if (parsed.itemFound && parsed.itemId !== null) {
                const newItem: CartItem = {
                    itemId: parsed.itemId,
                    name: parsed.itemName ?? 'Item',
                    qty: parsed.qty,
                    unitPrice: parsed.unitPrice,
                    foodCost: parsed.foodCost,
                    modifiers: parsed.modifiers,
                    lineTotal: parsed.qty * (parsed.unitPrice + parsed.modifierDelta),
                    isUpsold: false,
                };
                updatedCart = addToCart(updatedCart, newItem);

                // Upsell check
                const newSession = { ...session, cart: updatedCart, turnCount: session.turnCount + 1 };
                upsellSuggestion = getUpsellSuggestion(newSession, parsed.itemId);
                if (upsellSuggestion) {
                    const upsellLine = buildUpsellLine(upsellSuggestion, lang);
                    responseText = responseText + ' ' + upsellLine;

                    // Update upsell tracking
                    void updateSession(session.sessionId, {
                        upsell: {
                            ...session.upsell,
                            shownItemIds: [...session.upsell.shownItemIds, upsellSuggestion.itemId],
                            lastUpsellTurn: session.turnCount + 1,
                        },
                    }).catch(() => undefined);
                }

                // Offer nudge check
                const newTotal = computeCartTotal(updatedCart);
                const nudge = getOfferNudge(newTotal, lang);
                if (nudge && !session.upsell.offerNudgeSent) {
                    offerNudgeLine = nudge.nudgeText;
                    void updateSession(session.sessionId, {
                        upsell: { ...session.upsell, offerNudgeSent: true, offerNudgeTurn: session.turnCount + 1 },
                    }).catch(() => undefined);
                }
            }
            break;
        }

        case 'ORDER_REMOVE': {
            if (parsed.itemId !== null) {
                updatedCart = removeFromCart(updatedCart, parsed.itemId as number);
            }
            break;
        }

        case 'ORDER_MODIFY': {
            if (parsed.itemId !== null && parsed.modifications) {
                updatedCart = modifyCartItem(updatedCart, parsed.itemId as number, parsed.modifications);
            }
            break;
        }

        case 'CONFIRM_ORDER': {
            if (updatedCart.length === 0) {
                responseText = lang === 'hi'
                    ? 'à¤†à¤ªà¤•à¤¾ à¤‘à¤°à¥à¤¡à¤° à¤…à¤­à¥€ à¤–à¤¾à¤²à¥€ à¤¹à¥ˆà¥¤ à¤ªà¤¹à¤²à¥‡ à¤•à¥à¤› à¤œà¥‹à¤¡à¤¼à¥‡à¤‚à¥¤'
                    : lang === 'hinglish'
                    ? 'Order toh abhi empty hai. Pehle kuch add karo.'
                    : 'Your order is empty. Please add some items first.';
                nextState = 'COLLECTING_ORDER';
                break;
            }

            // Read back cart + ask for confirmation
            const total = computeCartTotal(updatedCart);
            const disc = computeOfferDiscount(total);
            const discAmt = disc?.discountAmt ?? 0;
            const net = total - discAmt;
            const summary = buildCartSummary(updatedCart, total, discAmt, net, lang);

            let confirmText: string;
            if (lang === 'hi') {
                confirmText = `à¤†à¤ªà¤•à¤¾ à¤‘à¤°à¥à¤¡à¤°:\n${summary}\n\nà¤•à¥à¤¯à¤¾ à¤†à¤ª à¤•à¤¨à¥à¤«à¤°à¥à¤® à¤•à¤°à¤¨à¤¾ à¤šà¤¾à¤¹à¤¤à¥‡ à¤¹à¥ˆà¤‚?`;
            } else if (lang === 'hinglish') {
                confirmText = `Aapka order:\n${summary}\n\nConfirm karna hai?`;
            } else {
                confirmText = `Here's your order:\n${summary}\n\nShall I place this order?`;
            }

            responseText = confirmText;
            nextState = 'AWAITING_CONFIRMATION';

            void updateSession(session.sessionId, { awaitingOrderConfirmation: true, state: 'AWAITING_CONFIRMATION' })
                .catch(() => undefined);
            session.awaitingOrderConfirmation = true;
            break;
        }

        case 'CANCEL_ORDER': {
            updatedCart = [];
            nextState = 'COLLECTING_ORDER';
            responseText = lang === 'hi'
                ? 'à¤†à¤ªà¤•à¤¾ à¤‘à¤°à¥à¤¡à¤° à¤°à¤¦à¥à¤¦ à¤¹à¥‹ à¤—à¤¯à¤¾à¥¤ à¤¨à¤¯à¤¾ à¤‘à¤°à¥à¤¡à¤° à¤¶à¥à¤°à¥‚ à¤•à¤°à¥‡à¤‚à¥¤'
                : lang === 'hinglish'
                ? 'Order cancel ho gaya. Naya order shuru karo.'
                : 'Order cancelled. Feel free to start a new order!';
            break;
        }

        // QUERY and SMALLTALK â€” responseText already contains the spoken response (plain text)
        default:
            nextState = session.state === 'COLLECTING_ORDER' ? 'COLLECTING_ORDER' : session.state;
            break;
    }

    const finalTotal = computeCartTotal(updatedCart);
    const discount = computeOfferDiscount(finalTotal);
    const discountAmt = discount?.discountAmt ?? 0;

    return buildOutput(
        session, responseText, intent, nextState,
        upsellSuggestion ? {
            itemId: upsellSuggestion.itemId,
            itemName: upsellSuggestion.itemName,
            price: upsellSuggestion.price,
            reason: upsellSuggestion.reason,
        } : null,
        offerNudgeLine,
        updatedCart, finalTotal, finalTotal - discountAmt, discountAmt,
        discount?.offerId ?? null
    );
}

// â”€â”€ Main entry point â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// ── Intent routing sets ──────────────────────────────────────────────────────
// CART_ONLY_INTENTS: update cache + async DB; no blocking writes
const CART_ONLY_INTENTS = new Set(['ORDER_ADD', 'ORDER_REMOVE', 'ORDER_MODIFY']);
// DB_WRITE_INTENTS: confirm/cancel/end — require async session state flush
const DB_WRITE_INTENTS = new Set(['CONFIRM_ORDER', 'CANCEL_ORDER', 'END_CALL']);

export async function processTurn(input: BrainInput): Promise<BrainOutput> {
    const { sessionId, transcript, restaurantId, detectedLanguage, isVoiceCall } = input;
    const startMs = Date.now();

    // 1. Load or create session
    let session = await getSession(sessionId);
    if (!session) {
        session = await createSession(sessionId, String(restaurantId), '');
    }

    // 2. Detect / sync language
    const lang = detectLanguage(transcript, detectedLanguage ?? session.language);
    if (lang !== session.language) {
        session.language = lang;
        void updateSession(sessionId, { language: lang }).catch(() => undefined);
    }

    log.info('Turn received', { sessionId, state: session.state, lang, transcriptLen: transcript.length });

    // 4. End-of-call check (highest priority)
    if (isEndOfCallSignal(transcript, lang)) {
        if (session.cart.length > 0 && !session.awaitingOrderConfirmation) {
            // Prompt to confirm before hanging up
            const total = computeCartTotal(session.cart);
            const disc = computeOfferDiscount(total);
            const discAmt = disc?.discountAmt ?? 0;
            const net = total - discAmt;
            const summary = buildCartSummary(session.cart, total, discAmt, net, lang);

            const responseText =
                lang === 'hi' ? `à¤°à¥à¤•à¤¿à¤! à¤†à¤ªà¤•à¥‡ à¤‘à¤°à¥à¤¡à¤° à¤®à¥‡à¤‚ à¤¹à¥ˆ:\n${summary}\nà¤•à¥à¤¯à¤¾ à¤•à¤¨à¥à¤«à¤°à¥à¤® à¤•à¤°à¥‚à¤?`
                : lang === 'hinglish' ? `Ek second! Aapke cart mein hai:\n${summary}\nConfirm karo?`
                : `Wait â€” you have items in your cart:\n${summary}\nShall I confirm your order before you go?`;

            void updateSession(sessionId, { awaitingOrderConfirmation: true, state: 'AWAITING_CONFIRMATION' })
                .catch(() => undefined);

            const out = buildOutput(session, responseText, 'END_SIGNAL', 'AWAITING_CONFIRMATION', null, null);
            void persistAssistantTurn(sessionId, out, startMs);
            return out;
        }

        // No cart or already past confirmation â€” end the call
        const responseText = endCallResponse(lang);
        void updateSession(sessionId, { callEnded: true, state: 'COMPLETED' }).catch(() => undefined);
        const out = buildOutput(session, responseText, 'END_CALL', 'COMPLETED', null, null, undefined, undefined, undefined, undefined, undefined, false, true, true);
        void persistAssistantTurn(sessionId, out, startMs);
        return out;
    }

    // 5. Identity collection
    if (session.state === 'IDENTITY_COLLECTION') {
        const out = await handleIdentityCollection(session, transcript);
        void persistAssistantTurn(sessionId, out, startMs);
        return out;
    }

    // 6. Awaiting order confirmation (yes/no)
    if (session.awaitingOrderConfirmation) {
        const out = await handleConfirmationResponse(session, transcript);
        void persistAssistantTurn(sessionId, out, startMs);
        return out;
    }

    // 7. Awaiting cuisine choice (returning customer "your usual?")
    if (session.awaitingCuisineChoice) {
        const out = await handleCuisineChoiceResponse(session, transcript);
        void persistAssistantTurn(sessionId, out, startMs);
        return out;
    }

    // 8. Build LLM history
    const history = await buildLLMHistory(sessionId, 8);

    // 9. Intent extraction
    const { intent, entities, language: detectedLang } = await extractIntent(transcript, history, lang);
    if (detectedLang !== lang) {
        session.language = detectedLang;
        void updateSession(sessionId, { language: detectedLang }).catch(() => undefined);
    }

    log.info('Intent classified', { sessionId, intent, lang: detectedLang });

    // 10a. QUERY_ORDER short-circuit — answer directly from session.cart, no LLM call.
    // "Can you repeat my order?" / "What's in my cart?" / "What's my total?"
    // These were previously mis-classified as CONFIRM_ORDER (which hardcodes "empty")
    // or fell to UNKNOWN where the LLM hallucinated an empty cart.
    if (intent === 'QUERY_ORDER') {
        const total = computeCartTotal(session.cart);
        const disc = computeOfferDiscount(total);
        const discAmt = disc?.discountAmt ?? 0;
        const net = total - discAmt;
        const summary = buildCartSummary(session.cart, total, discAmt, net, session.language);
        let responseText: string;
        const ql = session.language;
        if (session.cart.length === 0) {
            responseText = ql === 'hi'
                ? 'आपकी कार्ट अभी खाली है। क्या ऑर्डर करना है?'
                : ql === 'hinglish'
                    ? 'Aapki cart abhi empty hai. Kya order karna hai?'
                    : "Your cart is currently empty. What would you like to order?";
        } else {
            responseText = ql === 'hi'
                ? `आपके ऑर्डर में है:\n${summary}\nकुछ और चाहिए?`
                : ql === 'hinglish'
                    ? `Aapke cart mein hai:\n${summary}\nKuch aur?`
                    : `Here's your current order:\n${summary}\nWould you like to add anything else?`;
        }
        const out = buildOutput(session, responseText, 'QUERY_ORDER', session.state, null, null);
        applyToCache(sessionId, { lastIntent: 'QUERY_ORDER', language: out.language });
        void addTurn(sessionId, { role: 'user', content: transcript, metadata: { isVoiceCall, startMs } })
            .catch(() => undefined);
        void addTurn(sessionId, { role: 'assistant', content: out.responseText, intent: 'QUERY_ORDER', metadata: { processingMs: Date.now() - startMs } })
            .catch(() => undefined);
        log.info('QUERY_ORDER short-circuit', { sessionId, cartSize: session.cart.length, total });
        return out;
    }

    // 10. Route to handler
    const out = await routeIntent(session, transcript, intent, entities, history);

    // 11. Persist — only for mutation intents (add/remove/confirm/cancel)
    // Informational turns (QUERY, SMALLTALK) are in-memory only; no DB round-trip needed.
    if (CART_ONLY_INTENTS.has(intent)) {
        // ── Cart mutation: update cache + async DB write ───────────────────────
        // Cache is the live source-of-truth during the call.
        // The async DB write ensures cart survives a server restart mid-call.
        applyToCache(sessionId, {
            state: out.nextState,
            cart: out.updatedCart,
            cartTotal: out.cartTotal,
            lastIntent: intent,
            language: out.language,
            appliedDiscount: out.appliedDiscount,
            appliedOfferId: out.appliedOfferId,
            netTotal: out.netTotal,
        });

        // Persist cart to DB async — free background write, keeps cart safe
        // across server restarts and process crashes.
        void updateSession(sessionId, {
            state: out.nextState,
            cart: out.updatedCart,
            cartTotal: out.cartTotal,
            lastIntent: intent,
            language: out.language,
            appliedDiscount: out.appliedDiscount,
            appliedOfferId: out.appliedOfferId,
            netTotal: out.netTotal,
        }).catch(() => undefined);

        // Inject a [CART STATE] system turn so buildLLMHistory always shows
        // the current cart in conversation history — prevents the LLM from
        // ignoring the system-prompt cart and saying "cart is empty".
        const cartSnap = buildCartSummary(
            out.updatedCart, out.cartTotal, out.appliedDiscount, out.netTotal, out.language
        );
        const cartVerb = intent === 'ORDER_ADD' ? 'Added' : intent === 'ORDER_REMOVE' ? 'Removed' : 'Modified';
        pushSystemTurn(sessionId, `[CART STATE after ${cartVerb}] ${cartSnap}`);

        // Append turns to in-memory cache only (addTurn fires DB async for audit)
        void addTurn(sessionId, { role: 'user', content: transcript, metadata: { isVoiceCall, startMs } })
            .catch(() => undefined);
        void addTurn(sessionId, { role: 'assistant', content: out.responseText, intent, metadata: { processingMs: Date.now() - startMs } })
            .catch(() => undefined);

    } else if (DB_WRITE_INTENTS.has(intent)) {
        // ── Confirm / Cancel / End: async DB write for state transition ───────
        // CONFIRM_ORDER: saveCompletedOrder (called inside handleFinalConfirmation)
        // already wrote the order rows — we just sync session state.
        void (async () => {
            try {
                await addTurn(sessionId, { role: 'user', content: transcript, metadata: { isVoiceCall, startMs } });
                await addTurn(sessionId, { role: 'assistant', content: out.responseText, intent, metadata: { processingMs: Date.now() - startMs } });
                await updateSession(sessionId, {
                    state: out.nextState,
                    cart: out.updatedCart,
                    cartTotal: out.cartTotal,
                    lastIntent: intent,
                    language: out.language,
                    appliedDiscount: out.appliedDiscount,
                    appliedOfferId: out.appliedOfferId,
                    netTotal: out.netTotal,
                });
            } catch (err) {
                log.warn('Background persist failed', { error: (err as Error).message });
            }
        })();

    } else {
        // ── Read-only (QUERY, SMALLTALK, UNKNOWN): 0 DB calls ─────────────────
        applyToCache(sessionId, { lastIntent: intent, language: out.language });
    }

    log.info('Turn complete', {
        sessionId, intent, nextState: out.nextState,
        cartSize: out.updatedCart.length, total: out.cartTotal,
        processingMs: Date.now() - startMs,
    });

    return out;
}

// â”€â”€ Fire-and-forget assistant turn save â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function persistAssistantTurn(
    sessionId: string,
    out: BrainOutput,
    startMs: number
): Promise<void> {
    return addTurn(sessionId, {
        role: 'assistant',
        content: out.responseText,
        intent: out.intent,
        metadata: { processingMs: Date.now() - startMs },
    }).catch((err) => { log.warn('Assistant turn save failed', { error: (err as Error).message }); });
}
