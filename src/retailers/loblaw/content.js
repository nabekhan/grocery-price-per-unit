import { extractGrid } from './site.js';
import { isSortableTotalPrice, sortModels } from '../../sorting/sort.js';
import { annotate, clearAnnotation, createControl, injectStyles, updateStatus } from '../../ui/control.js';
import { claimRuntimeInstall } from '../../runtime/install.js';
import { areOnlyOwnedMutations } from '../../runtime/mutations.js';
import { captureWaitState, createScanScheduler } from '../../runtime/retailer-lifecycle.js';

/*!
 * Superstore/No Frills DOM adapter. Accepted API snapshots stay scoped to the
 * current query/store and join cards through stable product URLs. DOM price or
 * package text never replaces API facts; annotations, order, and narrowly
 * classified promotions are owned reversibly and released on stale state.
 */

const state = { dimension: 'auto', direction: 'asc', restored: true, observer: null };
const originalLocations = new Map();
const managedCards = new Set();
const hiddenPromotions = new Map();
const apiProducts = new Map();
let apiScope = null;
let apiRevision = 0;
let observedScope = currentScope();
let scopeWatcher = null;
let lifecycle = null;
let scheduleScan = null;
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

function userscriptStorage() {
  return globalThis[Symbol.for('grocery-price-per-unit.storage.v1')]?.storage;
}

const API_SOURCE = 'rcss-price-per-unit';
const API_VERSION = 2;
const isProductArray = Array.isArray;
const MAX_API_REVISION = 1_000_000;
const MAX_API_REVISION_ADVANCE = 10_000;
let apiMessageGeneration = 0;

function normalizedQuery(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  return value.trim().normalize('NFKC').replace(/\s+/g, ' ').toLowerCase() || null;
}

function normalizedStoreId(value) {
  return typeof value === 'string' && value.length <= 80
    ? value.trim().slice(0, 80) || null
    : null;
}

function scopedPage(query, storeId, pagePath) {
  return query
    ? `query:${query}|store:${storeId || ''}`
    : `page:${pagePath || ''}`;
}

function currentScope() {
  const url = new URL(location.href);
  const query = normalizedQuery(url.searchParams.get('search-bar'));
  return scopedPage(query, normalizedStoreId(url.searchParams.get('storeId')), `${url.pathname}${url.search}`);
}

export function getLoblawScope() {
  return currentScope();
}

function normalizeApiProduct(value, id) {
  if (!value || typeof value !== 'object' || !/^[a-zA-Z0-9._:-]+$/.test(id)
    || id === '__proto__' || id === 'prototype' || id === 'constructor') return null;
  const valueId = value.id;
  const valueName = value.name;
  const valuePackageSizing = value.packageSizing;
  const valueCurrentPrice = value.currentPrice;
  const valueRegularPrice = value.regularPrice;
  const valueDisplayPrice = value.displayPrice;
  const valueWeighted = value.weighted;
  if (valueId !== id) return null;
  const bounded = (input, maximum) => typeof input === 'string' && input.length <= maximum ? input : null;
  const price = (input) => input === null || input === undefined
    ? null
    : typeof input === 'number' && Number.isFinite(input) && input > 0 && input <= 1000000 ? input : NaN;
  const product = {
    id,
    name: bounded(valueName, 1500),
    packageSizing: bounded(valuePackageSizing, 256),
    currentPrice: price(valueCurrentPrice),
    regularPrice: price(valueRegularPrice),
    displayPrice: bounded(valueDisplayPrice, 80),
    weighted: typeof valueWeighted === 'boolean' ? valueWeighted : null
  };
  return product.name && !Number.isNaN(product.currentPrice) && !Number.isNaN(product.regularPrice)
    ? product
    : null;
}

function ingestApiMessage(event) {
  try {
    if (event.source !== window || event.origin !== location.origin) return;
    const transactionGeneration = ++apiMessageGeneration;
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    const source = message.source;
    const version = message.version;
    const type = message.type;
    const mode = message.mode;
    const productsPayload = message.products;
    const context = message.context;
    const revision = message.revision;
    if (source !== API_SOURCE || version !== API_VERSION || type !== 'api-products'
      || mode !== 'snapshot' || !isProductArray(productsPayload)) return;
    const productCount = productsPayload.length;
    if (!Number.isSafeInteger(productCount) || productCount < 0 || productCount > 500) return;
    const rawQuery = context?.query;
    const rawStoreId = context?.storeId;
    const rawPagePath = context?.pagePath;
    const query = normalizedQuery(rawQuery);
    const storeId = normalizedStoreId(rawStoreId);
    const pagePath = typeof rawPagePath === 'string' && rawPagePath.length <= 2048
      ? rawPagePath
      : '';
    const scope = scopedPage(query, storeId, pagePath);
    if (scope !== currentScope() || !Number.isSafeInteger(revision) || revision < 0
      || revision > MAX_API_REVISION || revision < apiRevision
      || revision - apiRevision > MAX_API_REVISION_ADVANCE) return;
    const nextProducts = new Map();
    for (let index = 0; index < productCount; index += 1) {
      const value = productsPayload[index];
      const id = value?.id;
      const product = normalizeApiProduct(value, id);
      if (!product) continue;
      if (nextProducts.has(id)) return;
      nextProducts.set(id, product);
    }
    if (transactionGeneration !== apiMessageGeneration) return;
    apiProducts.clear();
    for (const [id, product] of nextProducts) apiProducts.set(id, product);
    apiScope = scope;
    apiRevision = revision;
    log('accepted API products', { products: apiProducts.size, revision: apiRevision, scope });
    if (!lifecycle?.accept(scope)) schedule({ urgent: true });
  } catch (error) {
    log('Rejected malformed API product snapshot', error);
  }
}

async function loadDefaultMode() {
  const storage = userscriptStorage();
  if (!storage?.sync) return;
  try {
    const result = await storage.sync.get({ defaultSortMode: 'restore' });
    applyMode(result.defaultSortMode);
  } catch (error) { log('Could not load userscript preference', error); }
}

function ensureControl() {
  let control = document.getElementById('lups-control');
  if (control) return control;
  control = createControl((action) => {
    if (action.type === 'reload') return lifecycle?.reload();
    if (action.type === 'restore') state.restored = true;
    if (action.type === 'sort') { state.dimension = action.dimension; state.direction = action.direction; state.restored = false; }
    scan();
  }, state);
  if (!control) return null;
  if (!control.isConnected) document.body.append(control);
  return control;
}

function acquireOrdering(models) {
  for (const model of models) {
    if (!originalLocations.has(model.card)) {
      originalLocations.set(model.card, {
        parent: model.card.parentElement,
        index: [...model.card.parentElement.children].indexOf(model.card),
        order: {
          value: model.card.style.getPropertyValue('order'),
          priority: model.card.style.getPropertyPriority('order')
        },
        moved: false,
        destination: null
      });
    }
  }
}

function consolidate(models, container) {
  acquireOrdering(models);
  for (const model of models) {
    if (model.card.parentElement === container) continue;
    const location = originalLocations.get(model.card);
    location.moved = true;
    location.destination = container;
    container.append(model.card);
  }
}

function restoreOrdering(cards = [...originalLocations.keys()]) {
  const groups = new Map();
  for (const card of cards) {
    const location = originalLocations.get(card);
    if (!location) continue;
    if (location.order.value) card.style.setProperty('order', location.order.value, location.order.priority);
    else card.style.removeProperty('order');
    if (location.moved && card.isConnected && location.parent?.isConnected
      && card.parentElement === location.destination) {
      if (!groups.has(location.parent)) groups.set(location.parent, []);
      groups.get(location.parent).push({ card, index: location.index });
    }
    originalLocations.delete(card);
  }
  for (const [parent, entries] of groups) {
    for (const { card, index } of entries.sort((left, right) => left.index - right.index)) {
      const reference = parent.children[index] || null;
      if (reference !== card) parent.insertBefore(card, reference);
    }
  }
}

function reconcileManagedCards(models = []) {
  const current = new Set(models.map((model) => model.card));
  const released = [];
  for (const card of managedCards) {
    if (current.has(card)) continue;
    released.push(card);
    clearAnnotation(card);
    delete card.dataset.lupsDataSource;
    managedCards.delete(card);
  }
  restoreOrdering(released);
  for (const card of current) managedCards.add(card);
}

function restorePromotion(card) {
  const saved = hiddenPromotions.get(card);
  if (!saved) return;
  if (saved.value) card.style.setProperty('display', saved.value, saved.priority);
  else card.style.removeProperty('display');
  hiddenPromotions.delete(card);
}

function isRecognizedPromotion(card) {
  let marker = false;
  let productLink = false;
  let inspected = 0;
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_ELEMENT);
  for (let element = walker.nextNode(); element; element = walker.nextNode()) {
    inspected += 1;
    if (inspected > 400) return false;
    if (!marker && element.children.length === 0
      && !element.closest('a,button,input,select,textarea,[role="button"],[role="link"],[data-testid="product-title"]')
      && (element.textContent || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase() === 'sponsored') {
      marker = true;
    }
    const rawHref = element.localName === 'a' ? element.getAttribute('href') || '' : '';
    if (!productLink && (rawHref.includes('/product/') || rawHref.includes('/p/'))) {
      try {
        const url = new URL(element.href);
        const sources = url.searchParams.getAll('source');
        productLink = url.origin === location.origin
          && /(?:^|\/)(?:product|p)\/[^/]+/i.test(url.pathname)
          && sources.length === 1 && /^spt[dc]$/i.test(sources[0]);
      } catch { /* fail open */ }
    }
    if (marker && productLink) return true;
  }
  return false;
}

function restoreStalePromotions(currentCards = null) {
  for (const [card, saved] of hiddenPromotions) {
    if (!card.isConnected || card.parentElement !== saved.parent || !isRecognizedPromotion(card)
      || (currentCards && !currentCards.has(card))) restorePromotion(card);
  }
}

function hideRecognizedPromotions(models) {
  const excluded = new Set();
  for (const model of models) {
    if (!isRecognizedPromotion(model.card)) continue;
    if (!hiddenPromotions.has(model.card)) {
      hiddenPromotions.set(model.card, {
        value: model.card.style.getPropertyValue('display'),
        priority: model.card.style.getPropertyPriority('display'),
        parent: model.card.parentElement
      });
    }
    model.card.style.setProperty('display', 'none', 'important');
    excluded.add(model.card);
  }
  return excluded;
}

function restore(models, control, excluded = 0) {
  restoreOrdering();
  updateStatus(control, { total: models.length, excluded, restored: true });
}

function scan() {
  restoreStalePromotions();
  const scope = currentScope();
  if (apiScope !== scope) {
    window.postMessage({ source: API_SOURCE, version: API_VERSION, type: 'api-products-request' }, location.origin);
  }
  const grid = extractGrid(document, apiScope === scope ? apiProducts : null);
  if (!grid) {
    for (const [card] of hiddenPromotions) restorePromotion(card);
    reconcileManagedCards();
    const control = document.getElementById('lups-control');
    if (control) updateStatus(control, state.restored
      ? { total: undefined, excluded: 0, restored: true }
      : { total: undefined, excluded: 0, dataState: captureWaitState(lifecycle, scope) });
    return;
  }
  reconcileManagedCards(grid.models);
  restoreStalePromotions(new Set(grid.models.map((model) => model.card)));
  const control = ensureControl();
  if (!control) return;
  const excludedCards = hideRecognizedPromotions(grid.models);
  const models = grid.models.filter((model) => !excludedCards.has(model.card));
  for (const model of models) model.card.dataset.lupsDataSource = model.dataSource;
  for (const model of models) {
    if (model.dataSource === 'api') annotate(model);
    else clearAnnotation(model.card);
  }
  if (state.restored) return restore(models, control, excludedCards.size);
  if (apiScope !== scope) {
    restoreOrdering();
    updateStatus(control, {
      total: models.length,
      excluded: excludedCards.size,
      dataState: captureWaitState(lifecycle, scope)
    });
    return;
  }
  if (!models.some((model) => model.dataSource === 'api')) {
    restoreOrdering();
    updateStatus(control, { total: models.length, excluded: excludedCards.size, dataState: 'no-match' });
    return;
  }
  consolidate(models, grid.container);
  const sorted = sortModels(models, { dimension: state.dimension, direction: state.direction });
  sorted.items.forEach((model, index) => model.card.style.order = String(index));
  const sortable = models.filter((m) => sorted.dimension === 'total' ? isSortableTotalPrice(m.currentPrice) : m.dimension === sorted.dimension && Number.isFinite(m.normalizedUnitPrice)).length;
  const incompatible = sorted.dimension === 'total' ? 0 : models.filter((m) => m.dimension && m.dimension !== sorted.dimension && Number.isFinite(m.normalizedUnitPrice)).length;
  const unknown = models.length - sortable - incompatible;
  updateStatus(control, { dimension: sorted.dimension, sortable, incompatible, unknown, total: models.length, excluded: excludedCards.size, range: sorted.range });
  log('scan', { dimension: sorted.dimension, sortable, incompatible, unknown });
}

function schedule(options) {
  return scheduleScan?.(options) || false;
}

function detectScopeChange() {
  const nextScope = currentScope();
  if (nextScope === observedScope) return;
  observedScope = nextScope;
  lifecycle?.beginWaiting(nextScope);
  schedule();
}

async function start() {
  if (!document.body || document.getElementById('lups-control')) return;
  await loadDefaultMode();
  injectStyles();
  scan();
  state.observer = new MutationObserver((records) => {
    if (areOnlyOwnedMutations(records, (record) => record.target.closest?.('#lups-control,[data-lups-annotation]'))) return;
    schedule();
  });
  // Loblaw replaces the entire main element during SPA navigation, so the body is
  // the narrowest stable lifetime container. Debouncing keeps observation cheap.
  state.observer.observe(document.body, { attributes: true, attributeFilter: ['href'], characterData: true, childList: true, subtree: true });
  // Virtualized/lazy cards can also be populated by visibility changes that do
  // not mutate their content. Walmart uses the same explicit scroll rescan.
  window.addEventListener('scroll', schedule, { passive: true, capture: true });
  window.addEventListener('popstate', detectScopeChange, { passive: true });
  scopeWatcher = setInterval(detectScopeChange, 200);
  userscriptStorage()?.onChanged?.addListener((changes, area) => {
    if (area !== 'sync' || !changes.defaultSortMode) return;
    applyMode(changes.defaultSortMode.newValue);
    document.getElementById('lups-control')?.remove();
    schedule();
  });
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    state.observer?.disconnect();
    window.removeEventListener('scroll', schedule, { capture: true });
    window.removeEventListener('popstate', detectScopeChange);
    scheduleScan?.dispose();
    clearInterval(scopeWatcher);
    scopeWatcher = null;
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) scan();
  });
}

export function installLoblawRuntime(context = {}) {
  if (!claimRuntimeInstall('loblaw-content')) return false;
  lifecycle = context.lifecycle || null;
  scheduleScan = createScanScheduler(window, scan, { delayMs: 180 });
  lifecycle?.subscribe(() => schedule({ urgent: true }));
  window.addEventListener('message', ingestApiMessage);
  window.postMessage({ source: API_SOURCE, version: API_VERSION, type: 'api-products-request' }, location.origin);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
  return true;
}
