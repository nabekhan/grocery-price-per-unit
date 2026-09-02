import { MAX_RENDERED_CARDS } from '../limits.js';

export { MAX_RENDERED_CARDS } from '../limits.js';

/*!
 * Walmart's annotator and sorter are bundled together. Their shared model map
 * therefore stays in this module closure instead of a discoverable page-world
 * property. The page may mutate data-* attributes, globals, or prototypes, but
 * none of those become authoritative price input for the sorter.
 */
const MAX_API_CARDS = 500;
const DIMENSIONS = new Set(['mass', 'volume', 'count']);
const NativeWeakMap = WeakMap;
const arrayIsArray = Array.isArray;
const freeze = Object.freeze;
const setHas = Function.call.bind(Set.prototype.has);
const weakMapGet = Function.call.bind(WeakMap.prototype.get);
const weakMapSet = Function.call.bind(WeakMap.prototype.set);
const numberIsFinite = Number.isFinite;
const numberIsSafeInteger = Number.isSafeInteger;
let publishedState = null;

const positiveNumber = (value, maximum) => typeof value === 'number'
  && numberIsFinite(value) && value > 0 && value <= maximum ? value : null;
const boundedString = (value, maximum) => typeof value === 'string' && value.length > 0
  && value.length <= maximum ? value : null;

function modelForEntry(entry) {
  if (!entry?.card || (typeof entry.card !== 'object' && typeof entry.card !== 'function')) return null;
  return freeze({
    matched: entry.matched === true,
    productId: boundedString(entry.productId, 160),
    name: boundedString(entry.name, 1_500),
    normalizedUnitPrice: positiveNumber(entry.normalizedUnitPrice, 1_000_000_000),
    currentPrice: positiveNumber(entry.currentPrice, 1_000_000),
    dimension: setHas(DIMENSIONS, entry.dimension) ? entry.dimension : null
  });
}

function modelMap(entries) {
  const models = new NativeWeakMap();
  let count = 0;
  const length = arrayIsArray(entries) ? entries.length : 0;
  for (let index = 0; index < length && count < MAX_RENDERED_CARDS; index += 1) {
    const entry = entries[index];
    const model = modelForEntry(entry);
    if (!model) continue;
    weakMapSet(models, entry.card, model);
    count += 1;
  }
  return models;
}

function validatedState(summary, models) {
  const accepted = summary?.accepted === true;
  const renderedCards = numberIsSafeInteger(summary?.renderedCards) ? summary.renderedCards : -1;
  const apiCards = numberIsSafeInteger(summary?.apiCards) ? summary.apiCards : -1;
  if (renderedCards < 0 || renderedCards > MAX_RENDERED_CARDS
    || apiCards < 0 || apiCards > MAX_API_CARDS || apiCards > renderedCards) return null;
  return freeze({ accepted, renderedCards, apiCards, models });
}

export function publishApiScanState(summary, entries) {
  const previousState = publishedState;
  publishedState = validatedState(summary, modelMap(entries));
  if (!publishedState) return freeze({ state: null, changed: previousState !== null });
  return freeze({
    state: publishedState,
    changed: previousState?.accepted !== publishedState.accepted
      || previousState?.renderedCards !== publishedState.renderedCards
      || previousState?.apiCards !== publishedState.apiCards
  });
}

export function readApiScanState() {
  return publishedState;
}

export function readApiScanModel(state, card) {
  try {
    return state?.models && card ? weakMapGet(state.models, card) || null : null;
  } catch {
    return null;
  }
}
