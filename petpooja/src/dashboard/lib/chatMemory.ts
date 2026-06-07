// ─────────────────────────────────────────────────────────────────────────────
// Chat Memory — maintains conversation context for follow-up queries
// ─────────────────────────────────────────────────────────────────────────────

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

const MAX_MEMORY = 10;

/**
 * Resolves follow-up queries by merging context from recent conversation.
 * E.g. "show top items" → "only veg" becomes "show top veg items"
 */
export function resolveFollowUp(
  currentMessage: string,
  history: ChatMessage[]
): string {
  const low = currentMessage.toLowerCase().trim();

  // Short follow-up filters (under 6 words, no question mark, looks like a refinement)
  const isFollowUp =
    low.split(/\s+/).length <= 6 &&
    !low.endsWith("?") &&
    /\b(only|just|but|also|and|filter|show|what about|how about|exclude|include|instead|in|from|with)\b/i.test(
      low
    );

  if (!isFollowUp || history.length === 0) return currentMessage;

  // Find the last user message to merge with
  const lastUserMessages = history
    .filter((m) => m.role === "user")
    .slice(-3);

  if (lastUserMessages.length === 0) return currentMessage;

  const lastUserMsg = lastUserMessages[lastUserMessages.length - 1].content;

  // Detect filter-type follow-ups
  const vegMatch = low.match(/\b(only\s+)?(veg|vegetarian|non.?veg|non.?vegetarian)\b/i);
  const cuisineMatch = low.match(/\b(only\s+)?(punjabi|italian)\b/i);
  const categoryMatch = low.match(
    /\b(only\s+)?(starter|appetizer|main|bread|beverage|drink|dessert)\b/i
  );
  const countMatch = low.match(/\b(top\s+\d+|\d+\s+items?)\b/i);

  if (vegMatch || cuisineMatch || categoryMatch || countMatch) {
    // Merge: append filter to previous query
    const filter = currentMessage.replace(/^(only|just|but|show|filter)\s+/i, "").trim();
    return `${lastUserMsg} ${filter}`;
  }

  return currentMessage;
}

/**
 * Trims history to the last N messages.
 */
export function trimHistory(history: ChatMessage[]): ChatMessage[] {
  return history.slice(-MAX_MEMORY);
}
