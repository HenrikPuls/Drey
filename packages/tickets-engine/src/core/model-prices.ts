/**
 * The model price table (concept §4.3's cost attribution): a small,
 * static list of USD-per-1M-token rates for the models this repo runs —
 * the fallback when a provider reports no cost of its own (OpenCode's
 * coding plans and flat-rate sessions report nothing or a meaningless 0,
 * and the fleet's ledger must still be able to say what a run cost).
 *
 * APPROXIMATE, EDITORIALLY MAINTAINED: the numbers are generous public
 * list rates (Anthropic's published Claude tiers, Z.ai's GLM tiers,
 * Moonshot's Kimi rate), not a live price feed. A provider-reported cost
 * always wins over this table — the table only fills the gap. An unknown
 * model stays null: a guessed 0 would be a fake measurement.
 */

/** USD per 1M tokens: the input and the output side separately. */
export interface ModelPrice {
  readonly input: number;
  readonly output: number;
}

/**
 * Bare model ids → rates. Keys are matched on the id AFTER the provider
 * prefix (`zai/glm-5.3` → `glm-5.3`), lowercase; a `-flash` tier carries
 * its own cheaper row.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  // Anthropic's published list rates (approximate, editorially maintained).
  opus: { input: 15, output: 75 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
  // Z.ai GLM tiers (approximate, editorially maintained — the flagship's
  // rate estimated generously above the GLM-4.6 list price).
  'glm-5.3': { input: 1, output: 3 },
  'glm-5.3-flash': { input: 0.2, output: 0.8 },
  'glm-5.2': { input: 0.6, output: 2.2 },
  // Moonshot's Kimi K2 list rate (approximate, editorially maintained).
  'kimi-k2': { input: 0.6, output: 2.5 },
  // The Kimi Code CLI's aliases (E10-8) bill at the same editorial rate; the
  // highspeed tiers cost twice the usage, not twice the tokens — not modelled.
  k3: { input: 0.6, output: 2.5 },
  'k3-256k': { input: 0.6, output: 2.5 },
  'k3.1-pro': { input: 0.6, output: 2.5 },
  'k3.1-pro-highspeed': { input: 0.6, output: 2.5 },
  'kimi-for-coding': { input: 0.6, output: 2.5 },
  'kimi-for-coding-highspeed': { input: 0.6, output: 2.5 },
  'glm-5.3-highspeed': { input: 1, output: 3 },
};

/** The table key for a wire model string: the part after the last `/`, lowercase. */
export function priceKeyOf(model: string | null | undefined): string | null {
  const bare = (model ?? '').trim().toLowerCase();
  if (bare === '') {
    return null;
  }
  const slashAt = bare.lastIndexOf('/');
  return (slashAt === -1 ? bare : bare.slice(slashAt + 1)) || null;
}

/** The ledger's four-digit dollar rounding — one house convention everywhere. */
function round4(usd: number): number {
  return Math.round(usd * 10_000) / 10_000;
}

/**
 * The run's estimated cost in dollars from the table; null when the model
 * is unknown or no usage was reported (never a 0 fake). A provider cost,
 * when one exists, takes precedence at the call site — this only fills
 * the gap.
 */
export function costOf(model: string | null | undefined, tokensIn: number, tokensOut: number): number | null {
  if (tokensIn <= 0 && tokensOut <= 0) {
    return null;
  }
  const price = MODEL_PRICES[priceKeyOf(model) ?? ''];
  if (price === undefined) {
    return null;
  }
  return round4(((tokensIn * price.input + tokensOut * price.output) / 1_000_000));
}
