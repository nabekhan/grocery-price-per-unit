/*!
 * Lexical trusted-card channel used by retailer content and cart adapters.
 *
 * The page can forge DOM attributes and globals, but it cannot replace this
 * module closure's WeakMap. Only sanitized API-derived scan models are copied
 * into it, and callers must hold both the current state token and exact card.
 */

const DIMENSIONS = new Set(['mass', 'volume', 'count']);
const bounded = (value, maximum) => typeof value === 'string' && value.length > 0
  && value.length <= maximum ? value : null;
const positive = (value, maximum) => Number.isFinite(value) && value > 0 && value <= maximum ? value : null;

export function createTrustedCardProducts({ maximum = 500 } = {}) {
  let current = Object.freeze({ accepted: false, count: 0, models: new WeakMap() });

  function publish({ accepted = false, entries = [] } = {}) {
    const models = new WeakMap();
    let count = 0;
    for (const entry of Array.isArray(entries) ? entries.slice(0, maximum) : []) {
      const card = entry?.card;
      if (!card || (typeof card !== 'object' && typeof card !== 'function')) continue;
      const productId = bounded(entry.productId, 160);
      const name = bounded(entry.name, 1_500);
      models.set(card, Object.freeze({
        matched: entry.matched === true && Boolean(productId && name),
        productId,
        name,
        currentPrice: positive(entry.currentPrice, 1_000_000),
        normalizedUnitPrice: positive(entry.normalizedUnitPrice, 1_000_000_000),
        dimension: DIMENSIONS.has(entry.dimension) ? entry.dimension : null
      }));
      count += 1;
    }
    current = Object.freeze({ accepted: accepted === true, count, models });
    return current;
  }

  function readState() { return current; }
  function readModel(state, card) {
    try { return state === current && card ? state.models.get(card) || null : null; } catch { return null; }
  }

  return Object.freeze({ publish, readState, readModel });
}
