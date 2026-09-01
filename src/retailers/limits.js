/*!
 * Shared work budget. Search APIs are capped at 500 products; extra DOM
 * headroom accommodates recycled cards. Larger pages fail open instead of
 * turning a coalesced scan into unbounded per-card work.
 */
export const MAX_RENDERED_CARDS = 1_000;
