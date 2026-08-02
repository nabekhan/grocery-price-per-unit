import { extractGrid } from './site.js';
import { sortModels } from '../../sorting/sort.js';
import { annotate, createControl, injectStyles, updateStatus } from '../../ui/control.js';

const state = { dimension: 'auto', direction: 'asc', restored: true, observer: null, timer: null };
const originalLocations = new WeakMap();
const apiProducts = new Map();
let apiScope = null;
let apiRevision = 0;
const debug = false;
const log = (...args) => { if (debug) console.info('[Grocery Price Per Unit: Loblaw]', ...args); };

function applyMode(value = 'restore') {
  if (value === 'restore') state.restored = true;
  else {
    const match = /^(auto|mass|volume|count|total)-(asc|desc)$/.exec(value);
    if (!match) return;
    [, state.dimension, state.direction] = match;
    state.restored = false;
  }
}

function extensionStorage() {
  return globalThis.browser?.storage || globalThis.chrome?.storage;
}

const API_SOURCE = 'rcss-price-per-unit';
const API_VERSION = 1;

function normalizedQuery(value) {
  return typeof value === 'string'
    ? value.trim().normalize('NFKC').replace(/\s+/g, ' ').toLowerCase().slice(0, 256) || null
    : null;
}

function currentScope() {
  const url = new URL(location.href);
  const query = normalizedQuery(url.searchParams.get('search-bar'));
  return query ? `query:${query}` : `page:${url.pathname}${url.search}`;
}

function normalizeApiProduct(value, id) {
  if (!value || typeof value !== 'object' || value.id !== id || !/^[a-zA-Z0-9._:-]+$/.test(id)) return null;
  const bounded = (input, maximum) => typeof input === 'string' && input.length <= maximum ? input : null;
  const price = (input) => input === null || input === undefined
    ? null
    : typeof input === 'number' && Number.isFinite(input) && input >= 0 && input <= 1000000 ? input : NaN;
  const product = {
    id,
    name: bounded(value.name, 1500),
    packageSizing: bounded(value.packageSizing, 256),
    currentPrice: price(value.currentPrice),
    regularPrice: price(value.regularPrice),
    displayPrice: bounded(value.displayPrice, 80),
    weighted: typeof value.weighted === 'boolean' ? value.weighted : null
  };
  return product.name && !Number.isNaN(product.currentPrice) && !Number.isNaN(product.regularPrice)
    ? product
    : null;
}

function ingestApiMessage(event) {
  if (event.source !== window || event.origin !== location.origin) return;
  const message = event.data;
  if (message?.source !== API_SOURCE || message?.version !== API_VERSION || message?.type !== 'api-products'
    || message.mode !== 'snapshot' || !message.products || typeof message.products !== 'object' || Array.isArray(message.products)) return;
  const query = normalizedQuery(message.context?.query);
  const scope = query ? `query:${query}` : `page:${message.context?.pagePath || ''}`;
  if (scope !== currentScope() || !Number.isSafeInteger(message.revision) || message.revision < apiRevision) return;
  const entries = Object.entries(message.products);
  if (entries.length > 500) return;
  apiProducts.clear();
  for (const [id, value] of entries) {
    const product = normalizeApiProduct(value, id);
    if (product) apiProducts.set(id, product);
  }
  apiScope = scope;
  apiRevision = message.revision;
  log('accepted API products', { products: apiProducts.size, revision: apiRevision, scope });
  schedule();
}

window.addEventListener('message', ingestApiMessage);
window.postMessage({ source: API_SOURCE, version: API_VERSION, type: 'api-products-request' }, location.origin);

async function loadDefaultMode() {
  const storage = extensionStorage();
  if (!storage?.sync) return;
  try {
    const result = await storage.sync.get({ defaultSortMode: 'restore' });
    applyMode(result.defaultSortMode);
  } catch (error) { log('Could not load extension settings', error); }
}

function ensureControl() {
  let control = document.getElementById('lups-control');
  if (control) return control;
  control = createControl((action) => {
    if (action.type === 'restore') state.restored = true;
    if (action.type === 'sort') { state.dimension = action.dimension; state.direction = action.direction; state.restored = false; }
    scan();
  }, state);
  if (!control) return null;
  if (!control.isConnected) document.body.append(control);
  return control;
}

function rememberLocations(models) {
  for (const model of models) {
    if (!originalLocations.has(model.card)) {
      originalLocations.set(model.card, { parent: model.card.parentElement, index: [...model.card.parentElement.children].indexOf(model.card) });
    }
  }
}

function consolidate(models, container) {
  rememberLocations(models);
  for (const model of models) if (model.card.parentElement !== container) container.append(model.card);
}

function restore(models, control) {
  for (const model of models) model.card.style.removeProperty('order');
  const groups = new Map();
  for (const model of models) {
    const location = originalLocations.get(model.card);
    if (!location?.parent?.isConnected) continue;
    if (!groups.has(location.parent)) groups.set(location.parent, []);
    groups.get(location.parent).push({ card: model.card, index: location.index });
  }
  for (const [parent, cards] of groups) {
    for (const { card } of cards.sort((a, b) => a.index - b.index)) parent.append(card);
  }
  updateStatus(control, { total: models.length, restored: true });
}

function scan() {
  const scope = currentScope();
  if (apiScope !== scope) {
    window.postMessage({ source: API_SOURCE, version: API_VERSION, type: 'api-products-request' }, location.origin);
  }
  const grid = extractGrid(document, apiScope === scope ? apiProducts : null);
  if (!grid) return;
  const control = ensureControl();
  if (!control) return;
  for (const model of grid.models) model.card.dataset.lupsDataSource = model.dataSource;
  for (const model of grid.models) {
    if (model.dataSource === 'api') annotate(model);
    else model.card.querySelector('[data-lups-annotation]')?.remove();
  }
  if (state.restored) return restore(grid.models, control);
  consolidate(grid.models, grid.container);
  const sorted = sortModels(grid.models, { dimension: state.dimension, direction: state.direction });
  sorted.items.forEach((model, index) => model.card.style.order = String(index));
  const sortable = grid.models.filter((m) => sorted.dimension === 'total' ? Number.isFinite(m.currentPrice) : m.dimension === sorted.dimension && Number.isFinite(m.normalizedUnitPrice)).length;
  const incompatible = sorted.dimension === 'total' ? 0 : grid.models.filter((m) => m.dimension && m.dimension !== sorted.dimension && Number.isFinite(m.normalizedUnitPrice)).length;
  const unknown = grid.models.length - sortable - incompatible;
  updateStatus(control, { dimension: sorted.dimension, sortable, incompatible, unknown, total: grid.models.length });
  log('scan', { dimension: sorted.dimension, sortable, incompatible, unknown });
}

function schedule() {
  clearTimeout(state.timer);
  state.timer = setTimeout(scan, 180);
}

async function start() {
  if (!document.body || document.getElementById('lups-control')) return;
  await loadDefaultMode();
  injectStyles();
  scan();
  state.observer = new MutationObserver((records) => {
    if (records.every((record) => record.target.closest?.('#lups-control,[data-lups-annotation]'))) return;
    schedule();
  });
  // Loblaw replaces the entire main element during SPA navigation, so the body is
  // the narrowest stable lifetime container. Debouncing keeps observation cheap.
  state.observer.observe(document.body, { childList: true, subtree: true });
  // Virtualized/lazy cards can be populated by text and visibility changes that
  // do not add a child node. Walmart uses the same explicit scroll rescan.
  window.addEventListener('scroll', schedule, { passive: true, capture: true });
  extensionStorage()?.onChanged?.addListener((changes, area) => {
    if (area !== 'sync' || !changes.defaultSortMode) return;
    applyMode(changes.defaultSortMode.newValue);
    document.getElementById('lups-control')?.remove();
    schedule();
  });
  window.addEventListener('pagehide', () => {
    state.observer?.disconnect();
    window.removeEventListener('scroll', schedule, { capture: true });
    clearTimeout(state.timer);
  }, { once: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
