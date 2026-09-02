import { parseProduct } from '../../parsing/parser.js';
import { isSortableTotalPrice, sortModels } from '../../sorting/sort.js';
import { annotate, clearAnnotation, createControl, injectStyles, updateStatus } from '../../ui/control.js';
import { MAX_RENDERED_CARDS } from '../limits.js';
import { claimRuntimeInstall } from '../../runtime/install.js';
import { areOnlyOwnedMutations } from '../../runtime/mutations.js';
import { captureWaitState, createScanScheduler } from '../../runtime/retailer-lifecycle.js';
import { createTrustedCardProducts, createTrustedProductSnapshot } from '../../runtime/trusted-card-products.js';

/*!
 * Save-On result adapter. Candidate regions are ranked by overlap with current
 * API product IDs so recommendations cannot become the sortable grid. Missing
 * or stale API state restores retailer order/display; only the exact sponsored
 * shimmer placeholder contract may be hidden.
 */

const SOURCE = 'saveon-price-per-unit';
const VERSION = 2;
const isProductArray = Array.isArray;
const MAX_API_REVISION = 1_000_000;
const MAX_API_REVISION_ADVANCE = 10_000;
const products = new Map();
const originalOrder = new WeakMap();
const managedCards = new Map();
const hiddenPromotions = new Map();
const state = { dimension: 'auto', direction: 'asc', restored: true, scope: null, revision: 0 };
let apiMessageGeneration = 0;

const storage = () => globalThis[Symbol.for('grocery-price-per-unit.storage.v1')]?.storage;
const normalizedQuery = (value) => typeof value === 'string' && value.length <= 256
  ? value.trim().normalize('NFKC').replace(/\s+/g, ' ').toLowerCase() || null
  : null;
const normalizedStoreId = (value) => typeof value === 'string' && value.length <= 80
  ? value.trim().toLowerCase() || null
  : null;
const query = () => normalizedQuery(new URL(location.href).searchParams.get('q'));
const routeScope = (pathname, value) => value
  ? `${pathname.replace(/\/$/, '')}?q=${encodeURIComponent(value)}`
  : `page:${pathname}${location.search}`;
const scope = () => routeScope(location.pathname, query());
export const getSaveOnScope = () => scope();
let observedScope = scope();
let scopeWatcher = null;
let observer = null;
let lifecycle = null;
let scheduleScan = null;
let isSearchPage = () => true;
const shoppingProducts = createTrustedCardProducts();
const shoppingSnapshot = createTrustedProductSnapshot();
export const readSaveOnShoppingState = shoppingProducts.readState;
export const readSaveOnShoppingModel = shoppingProducts.readModel;
export const readSaveOnShoppingSnapshot = () => state.scope === scope()
  ? shoppingSnapshot.readState()
  : Object.freeze({ accepted: false, count: 0, products: Object.freeze([]) });

function messageScope(context) {
    const rawQuery = context?.query;
    const rawStoreId = context?.storeId;
    const pagePath = context?.pagePath;
    const value = normalizedQuery(rawQuery);
    const storeId = normalizedStoreId(rawStoreId);
    if (!value || typeof pagePath !== 'string' || pagePath.length > 2048) return null;
    try {
      const url = new URL(pagePath, location.origin);
      const pathStoreId = normalizedStoreId(url.pathname.match(/\/rsid\/([^/]+)\/results\/?$/i)?.[1]);
      if (url.origin !== location.origin || normalizedQuery(url.searchParams.get('q')) !== value
        || (pathStoreId && pathStoreId !== storeId)) return null;
      return routeScope(url.pathname, value);
  } catch {
    return null;
  }
}

function applyMode(value = 'restore') {
  if (value === 'restore') state.restored = true;
  else {
    const match = /^(auto|mass|volume|count|total)-(asc|desc)$/.exec(value);
    if (!match) return;
    [, state.dimension, state.direction] = match;
    state.restored = false;
  }
}

export function normalizeSaveOnApiProduct(value, id) {
  if (!value || typeof value !== 'object' || !/^[a-zA-Z0-9._:-]+$/.test(id)
    || id === '__proto__' || id === 'prototype' || id === 'constructor') return null;
  const valueId = value.id;
  const valueName = value.name;
  const valueCurrentPrice = value.currentPrice;
  const valueUnitPrice = value.unitPrice;
  const rawUnitOfSize = value.unitOfSize;
  if (valueId !== id) return null;
  const bounded = (input, max) => typeof input === 'string' && input.length <= max ? input : null;
  const price = valueCurrentPrice == null ? null : typeof valueCurrentPrice === 'number'
    && Number.isFinite(valueCurrentPrice) && valueCurrentPrice > 0 && valueCurrentPrice <= 1_000_000
    ? valueCurrentPrice
    : NaN;
  const rawSize = rawUnitOfSize && typeof rawUnitOfSize === 'object' && !Array.isArray(rawUnitOfSize)
    ? rawUnitOfSize
    : null;
  const rawSizeValue = rawSize?.size;
  const rawAbbreviation = rawSize?.abbreviation;
  const rawType = rawSize?.type;
  const rawAvailable = value.available ?? value.isAvailable;
  const size = typeof rawSizeValue === 'number' && Number.isFinite(rawSizeValue)
    && rawSizeValue > 0 && rawSizeValue <= 1_000_000_000 ? rawSizeValue : null;
  const abbreviation = bounded(rawAbbreviation, 32);
  const type = bounded(rawType, 64);
  const unitOfSize = size && (abbreviation || type) ? { size, abbreviation, type } : null;
  const name = bounded(valueName, 1500);
  return name && !Number.isNaN(price) ? {
    id, name, currentPrice: price, unitPrice: bounded(valueUnitPrice, 160), unitOfSize,
    available: rawAvailable === false ? false : true
  } : null;
}

// A DOM-free twin of the grid parser. It lets Cart Builder plan directly from
// the accepted search response before virtualized cards/images exist.
export function modelForSaveOnApiProduct(api) {
  if (!api?.id || !api?.name) return null;
  const size = api.unitOfSize;
  const rawPackageText = size?.size && (size.abbreviation || size.type)
    ? `${size.size} ${size.abbreviation || size.type}` : '';
  return parseProduct({
    productId: api.id, name: api.name, currentPrice: api.currentPrice,
    rawPackageText, rawUnitPriceText: api.unitPrice || '', promotionText: '', currentPriceCertain: true
  });
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
    const context = message.context;
    const revision = message.revision;
    const productsPayload = message.products;
    const incomingScope = messageScope(context);
    if (source !== SOURCE || version !== VERSION
      || type !== 'api-products' || mode !== 'snapshot' || incomingScope !== scope()
      || !Number.isSafeInteger(revision) || revision < 0 || revision > MAX_API_REVISION
      || revision < state.revision || revision - state.revision > MAX_API_REVISION_ADVANCE
      || !isProductArray(productsPayload)) return;
    const productCount = productsPayload.length;
    if (!Number.isSafeInteger(productCount) || productCount < 0 || productCount > 500) return;
    const nextProducts = new Map();
    for (let index = 0; index < productCount; index += 1) {
      const value = productsPayload[index];
      const id = value?.id;
      const product = normalizeSaveOnApiProduct(value, id);
      if (!product) continue;
      if (nextProducts.has(id)) return;
      nextProducts.set(id, product);
    }
    if (transactionGeneration !== apiMessageGeneration) return;
    products.clear();
    for (const [id, product] of nextProducts) products.set(id, product);
    state.scope = incomingScope;
    state.revision = revision;
    shoppingSnapshot.publish({
      accepted: true,
      products: [...products.values()].map((product) => ({
        ...modelForSaveOnApiProduct(product), matched: true, addable: product.available !== false
      }))
    });
    if (!lifecycle?.accept(incomingScope)) schedule({ urgent: true });
  } catch {
    // Reject the complete snapshot transaction when any message-owned getter
    // fails. The previously accepted cache/scope/revision stay authoritative.
  }
}

function productId(article) {
  return article.dataset.testid?.match(/^ProductCardWrapper-(.+)$/)?.[1] || null;
}

function directChildUnder(node, ancestor) {
  let child = node;
  while (child?.parentElement && child.parentElement !== ancestor) child = child.parentElement;
  return child?.parentElement === ancestor ? child : null;
}

function restorePromotion(wrapper) {
  const saved = hiddenPromotions.get(wrapper);
  if (!saved) return;
  if (saved.value) wrapper.style.setProperty('display', saved.value, saved.priority);
  else wrapper.style.removeProperty('display');
  hiddenPromotions.delete(wrapper);
}

function sponsoredPlaceholders(container) {
  const markerNodes = container.querySelectorAll('.pfg-shimmer > [aria-label="Loading sponsored product"]');
  if (markerNodes.length > MAX_RENDERED_CARDS) {
    for (const [wrapper] of hiddenPromotions) restorePromotion(wrapper);
    return null;
  }
  const wrappers = new Set();
  for (const marker of markerNodes) {
    const article = marker.closest('article');
    const wrapper = directChildUnder(article, container);
    if (wrapper && !wrapper.querySelector('article[data-testid^="ProductCardWrapper-"]')) wrappers.add(wrapper);
  }
  for (const [wrapper] of hiddenPromotions) {
    if (!wrappers.has(wrapper)) restorePromotion(wrapper);
  }
  for (const wrapper of wrappers) {
    if (!hiddenPromotions.has(wrapper)) {
      hiddenPromotions.set(wrapper, {
        value: wrapper.style.getPropertyValue('display'),
        priority: wrapper.style.getPropertyPriority('display')
      });
    }
    wrapper.style.setProperty('display', 'none', 'important');
  }
  return wrappers.size;
}

function extractGrid() {
  const articleNodes = document.querySelectorAll('article[data-testid^="ProductCardWrapper-"]');
  if (articleNodes.length > MAX_RENDERED_CARDS) return null;
  const articles = [...articleNodes];
  const groups = new Map();
  for (const article of articles) {
    const container = article.parentElement?.parentElement;
    if (!container) continue;
    if (!groups.has(container)) groups.set(container, []);
    groups.get(container).push(article);
  }
  const activeProducts = state.scope === scope() ? products : null;
  const candidates = [...groups.entries()].filter(([, cards]) => cards.length >= 2).map(([container, cards]) => ({
    container,
    cards,
    overlap: activeProducts ? cards.filter((card) => activeProducts.has(productId(card))).length : 0
  })).sort((left, right) => right.overlap - left.overlap || right.cards.length - left.cards.length);
  if (!candidates.length) return null;
  const [selected, runnerUp] = candidates;
  // Before a current-route snapshot arrives we cannot use overlap. Retain a
  // clear largest listing grid so active mode can truthfully preserve its
  // website order; fail open only when the page shape is genuinely ambiguous.
  if (candidates.length > 1 && selected.overlap === 0 && selected.cards.length === runnerUp?.cards.length) return null;
  if (runnerUp && selected.overlap === runnerUp.overlap && selected.cards.length === runnerUp.cards.length) return null;
  const { container: grid, cards } = selected;
  return {
    container: grid,
    models: cards.map((article) => {
      const id = productId(article);
      const api = state.scope === scope() ? products.get(id) : null;
      const size = api?.unitOfSize;
      const rawPackageText = size?.size && (size.abbreviation || size.type) ? `${size.size} ${size.abbreviation || size.type}` : '';
      const parsed = parseProduct({
        productId: id,
        name: api?.name || '',
        currentPrice: api?.currentPrice ?? null,
        rawPackageText,
        rawUnitPriceText: api?.unitPrice || '',
        promotionText: '',
        currentPriceCertain: true
      });
      return { ...parsed, card: article.parentElement, productCard: article, dataSource: api ? 'api' : 'missing-api' };
    })
  };
}

function rememberOrder(card) {
  if (originalOrder.has(card)) return;
  originalOrder.set(card, {
    value: card.style.getPropertyValue('order'),
    priority: card.style.getPropertyPriority('order')
  });
}

function restoreOrder(card) {
  const saved = originalOrder.get(card);
  if (!saved) return;
  if (saved.value) card.style.setProperty('order', saved.value, saved.priority);
  else card.style.removeProperty('order');
  originalOrder.delete(card);
}

function reconcileManagedCards(models = []) {
  const current = new Set(models.map((model) => model.card));
  for (const [card, productCard] of managedCards) {
    if (current.has(card)) continue;
    restoreOrder(card);
    clearAnnotation(productCard);
    managedCards.delete(card);
  }
  for (const model of models) {
    managedCards.set(model.card, model.productCard);
  }
}

function ensureControl() {
  return document.getElementById('lups-control') || createControl((action) => {
    if (action.type === 'reload') return lifecycle?.reload();
    if (action.type === 'restore') state.restored = true;
    else { state.dimension = action.dimension; state.direction = action.direction; state.restored = false; }
    scan();
  }, state);
}

function leaveSearchPage() {
  for (const [wrapper] of hiddenPromotions) restorePromotion(wrapper);
  reconcileManagedCards();
  document.getElementById('lups-control')?.remove();
  shoppingProducts.publish();
  shoppingSnapshot.publish();
  window.dispatchEvent(new CustomEvent('ppu-products-updated'));
}

function publishShoppingProducts(models = [], accepted = false) {
  shoppingProducts.publish({
    accepted,
    entries: models.map((model) => ({
      card: model.card,
      matched: model.dataSource === 'api',
      productId: model.productId,
      name: model.name,
      currentPrice: model.currentPrice,
      normalizedUnitPrice: model.normalizedUnitPrice,
      dimension: model.dimension
    }))
  });
  window.dispatchEvent(new CustomEvent('ppu-products-updated'));
}

function scan() {
  if (!isSearchPage()) {
    leaveSearchPage();
    return;
  }
  if (state.scope !== scope()) window.postMessage({ source: SOURCE, version: VERSION, type: 'api-products-request' }, location.origin);
  const grid = extractGrid();
  if (!grid) {
    for (const [wrapper] of hiddenPromotions) restorePromotion(wrapper);
    reconcileManagedCards();
    const control = document.getElementById('lups-control');
    if (control) updateStatus(control, state.restored
      ? { total: undefined, excluded: 0, restored: true }
      : { total: undefined, excluded: 0, dataState: captureWaitState(lifecycle, scope()) });
    publishShoppingProducts([], state.scope === scope());
    return;
  }
  const control = ensureControl();
  if (!control) return;
  reconcileManagedCards(grid.models);
  const excluded = sponsoredPlaceholders(grid.container);
  if (excluded === null) {
    for (const model of grid.models) {
      restoreOrder(model.card);
      clearAnnotation(model.productCard);
    }
    updateStatus(control, state.restored
      ? { total: grid.models.length, excluded: 0, restored: true }
      : {
        total: grid.models.length,
        excluded: 0,
        dataState: captureWaitState(lifecycle, scope())
      });
    publishShoppingProducts([], false);
    return;
  }
  publishShoppingProducts(grid.models, state.scope === scope());
  for (const model of grid.models) {
    if (model.dataSource === 'api') annotate(model);
    else clearAnnotation(model.productCard);
  }
  if (state.restored) {
    for (const model of grid.models) restoreOrder(model.card);
    updateStatus(control, { total: grid.models.length, excluded, restored: true });
    return;
  }
  if (state.scope !== scope()) {
    for (const model of grid.models) restoreOrder(model.card);
    updateStatus(control, {
      total: grid.models.length,
      excluded,
      dataState: captureWaitState(lifecycle, scope())
    });
    return;
  }
  if (!grid.models.some((model) => model.dataSource === 'api')) {
    for (const model of grid.models) restoreOrder(model.card);
    updateStatus(control, { total: grid.models.length, excluded, dataState: 'no-match' });
    return;
  }
  const sorted = sortModels(grid.models, { dimension: state.dimension, direction: state.direction });
  sorted.items.forEach((model, index) => {
    rememberOrder(model.card);
    model.card.style.order = String(index);
  });
  const sortable = grid.models.filter((model) => sorted.dimension === 'total' ? isSortableTotalPrice(model.currentPrice)
    : model.dimension === sorted.dimension && Number.isFinite(model.normalizedUnitPrice)).length;
  const incompatible = sorted.dimension === 'total' ? 0 : grid.models.filter((model) => model.dimension
    && model.dimension !== sorted.dimension && Number.isFinite(model.normalizedUnitPrice)).length;
  updateStatus(control, {
    dimension: sorted.dimension,
    sortable,
    incompatible,
    unknown: grid.models.length - sortable - incompatible,
    total: grid.models.length,
    excluded,
    range: sorted.range
  });
}

function schedule(options) {
  return scheduleScan?.(options) || false;
}

function detectScopeChange() {
  const nextScope = scope();
  if (nextScope === observedScope) return;
  observedScope = nextScope;
  lifecycle?.beginWaiting(nextScope);
  schedule();
}

async function start() {
  if (!document.body) return;
  const result = await storage()?.sync?.get({ defaultSortMode: 'restore' }).catch(() => null);
  applyMode(result?.defaultSortMode);
  injectStyles();
  scan();
  observer = new MutationObserver((records) => {
    if (!areOnlyOwnedMutations(records, (record) => record.target.closest?.('#lups-control,[data-lups-annotation],#gppu-shopping-assistant'))) schedule();
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-testid', 'aria-label'], childList: true, subtree: true });
  window.addEventListener('scroll', schedule, { passive: true, capture: true });
  window.addEventListener('popstate', detectScopeChange, { passive: true });
  scopeWatcher = setInterval(detectScopeChange, 200);
  storage()?.onChanged?.addListener((changes, area) => {
    if (area !== 'sync' || !changes.defaultSortMode) return;
    applyMode(changes.defaultSortMode.newValue);
    document.getElementById('lups-control')?.remove();
    schedule();
  });
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    observer?.disconnect();
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

export function installSaveOnRuntime(context = {}) {
  if (!claimRuntimeInstall('saveon-content')) return false;
  lifecycle = context.lifecycle || null;
  isSearchPage = typeof context.isSearchPage === 'function' ? context.isSearchPage : () => true;
  scheduleScan = createScanScheduler(window, scan, { delayMs: 160 });
  lifecycle?.subscribe(() => schedule({ urgent: true }));
  window.addEventListener('message', ingestApiMessage);
  window.postMessage({ source: SOURCE, version: VERSION, type: 'api-products-request' }, location.origin);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
  return true;
}
