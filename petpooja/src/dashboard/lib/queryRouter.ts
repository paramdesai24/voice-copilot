// ─────────────────────────────────────────────────────────────────────────────
// Query Router — classifies user queries into response types
// ─────────────────────────────────────────────────────────────────────────────

export type ResponseType = "chart" | "table" | "text";
export type ChartType = "bar" | "line" | "pie";

export interface RouteResult {
  responseType: ResponseType;
  chartType?: ChartType;
}

/**
 * Determines how the query response should be rendered.
 */
export function routeQuery(message: string): RouteResult {
  const low = message.toLowerCase();

  // ── Line chart triggers ──
  if (
    /\b(trend|revenue\s*trend|sales\s*trend|over\s*time|growth|daily\s*revenue|revenue\s*over)\b/i.test(low)
  ) {
    return { responseType: "chart", chartType: "line" };
  }

  // ── Pie chart triggers ──
  if (
    /\b(share|distribution|breakdown|split|proportion|category\s*share|cuisine\s*share|pie)\b/i.test(low)
  ) {
    return { responseType: "chart", chartType: "pie" };
  }

  // ── Bar chart triggers ──
  if (
    /\b(compare|comparison|versus|vs|rank|ranking|top\s*\d+|best\s*\d+|highest|lowest|bar\s*chart)\b/i.test(low) &&
    /\b(margin|price|revenue|popular|selling|item|menu)\b/i.test(low)
  ) {
    return { responseType: "chart", chartType: "bar" };
  }

  // ── Bar chart for peak hours ──
  if (/\b(peak|busy|rush\s*hour|orders?\s*by\s*hour|hourly)\b/i.test(low)) {
    return { responseType: "chart", chartType: "bar" };
  }

  // ── Table triggers ──
  if (
    /\b(list|table|all\s*item|full\s*menu|catalog|show\s*all|combo|customer|segment|offer|discount)\b/i.test(low)
  ) {
    return { responseType: "table" };
  }

  // Default: text
  return { responseType: "text" };
}
