/**
 * Single source of truth for the Antigravity elastic fallback chain.
 *
 * The chain used to be duplicated in the pool manager, the config defaults and
 * the config API whitelist. A model that existed in one copy but not upstream
 * (`gemini-3.5-flash-lite`) produced tens of thousands of 404s before it was
 * removed from every copy by hand, so the list lives here as a leaf module that
 * all three can import without creating a cycle.
 *
 * Ordering is low tier to high tier: a request only ever falls forward to a
 * stronger model once its own tier is exhausted.
 */
export const ANTIGRAVITY_ELASTIC_MODEL_ORDER = Object.freeze([
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-3.1-flash-lite',
    'gemini-3-flash',
    'gemini-3.6-flash-medium',
    'gemini-3.7-flash-medium'
]);

export const ANTIGRAVITY_ELASTIC_SOURCE_MODEL = ANTIGRAVITY_ELASTIC_MODEL_ORDER[0];
