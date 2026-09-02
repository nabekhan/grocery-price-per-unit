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

/*
 * Current-query product snapshots are deliberately separate from the card
 * WeakMap above.  A search response can contain every first-page product long
 * before (or without) the storefront rendering every image/card.  Cart
 * planning may rank that sanitized response, but adding still revalidates a
 * real card and control before it clicks anything.
 */
export function createTrustedProductSnapshot({ maximum = 500 } = {}) {
  let current = Object.freeze({ accepted: false, count: 0, products: Object.freeze([]) });

  function publish({ accepted = false, products = [] } = {}) {
    const next = [];
    const seen = new Set();
    for (const value of Array.isArray(products) ? products.slice(0, maximum) : []) {
      const productId = bounded(value?.productId, 160);
      const name = bounded(value?.name, 1_500);
      if (!productId || !name || seen.has(productId)) continue;
      seen.add(productId);
      next.push(Object.freeze({
        matched: value?.matched === true,
        // API snapshots prove product availability, not the presence of a
        // rendered Add button. The add phase still checks that control.
        addable: value?.addable !== false,
        productId,
        name,
        currentPrice: positive(value?.currentPrice, 1_000_000),
        normalizedUnitPrice: positive(value?.normalizedUnitPrice, 1_000_000_000),
        dimension: DIMENSIONS.has(value?.dimension) ? value.dimension : null
      }));
    }
    current = Object.freeze({ accepted: accepted === true, count: next.length, products: Object.freeze(next) });
    return current;
  }

  return Object.freeze({ publish, readState: () => current });
}
