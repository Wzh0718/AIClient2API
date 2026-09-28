/**
 * Single source of truth for the Antigravity elastic fallback chain.
 *
 * The chain used to be duplicated in the pool manager, the config defaults and
 * the config API whitelist. An earlier listing of `gemini-3.5-flash-lite` caused
 * upstream 404s; it was added back only after a real generation and upstream
 * model-list check succeeded. Keep the list here so the three consumers stay in sync.
 *
 * Ordering follows Google's Standard text input/output prices, low to high.
 * Equal-price 2.5 Flash stays ahead of 3.5 Flash-Lite. A request only falls
 * forward once its own model is exhausted.
 *
 * The 3.8 effort tiers are deliberately excluded: they remain directly
 * requestable, but are never fallback targets, so an exhausted 3.8 tier cannot
 * turn lower-tier traffic into mass 429s.
 */
export const ANTIGRAVITY_ELASTIC_MODEL_ORDER = Object.freeze([
    'gemini-2.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3-flash'
]);

export const ANTIGRAVITY_ELASTIC_SOURCE_MODEL = ANTIGRAVITY_ELASTIC_MODEL_ORDER[0];
