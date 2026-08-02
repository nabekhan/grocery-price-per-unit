import { parseProduct } from '../../parsing/parser.js';
import { sortModels } from '../../sorting/sort.js';
import { annotate, createControl, injectStyles, updateStatus } from '../../ui/control.js';

const SOURCE = 'saveon-price-per-unit';
const VERSION = 1;
const products = new Map();
const originalOrder = new WeakMap();
const state = { dimension: 'auto', direction: 'asc', restored: true, scope: null, revision: 0, timer: null };

const storage = () => globalThis.browser?.storage || globalThis.chrome?.storage;
const query = () => new URL(location.href).searchParams.get('q')?.trim().normalize('NFKC').replace(/\s+/g, ' ').toLowerCase() || null;
const scope = () => query() ? `query:${query()}` : `page:${location.pathname}${location.search}`;

function applyMode(value = 'restore') {
  if (value === 'restore') state.restored = true;
  else {
    const match = /^(auto|mass|volume|count|total)-(asc|desc)$/.exec(value);
    if (!match) return;
    [, state.dimension, state.direction] = match;
    state.restored = false;
  }
}

function normalizeProduct(value, id) {
  if (!value || value.id !== id || !/^[a-zA-Z0-9._:-]+$/.test(id)) return null;
  const bounded = (input, max) => typeof input === 'string' && input.length <= max ? input : null;
  const price = value.currentPrice == null ? null : Number(value.currentPrice);
  return bounded(value.name, 1500) && (price == null || Number.isFinite(price)) ? {
    id, name: value.name, currentPrice: price, unitPrice: bounded(value.unitPrice, 160), unitOfSize: value.unitOfSize
  } : null;
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (event.source !== window || event.origin !== location.origin || message?.source !== SOURCE || message?.version !== VERSION
    || message.type !== 'api-products' || message.mode !== 'snapshot' || message.context?.query !== query()
    || !Number.isSafeInteger(message.revision) || message.revision < state.revision || typeof message.products !== 'object') return;
  const entries = Object.entries(message.products);
  if (entries.length > 500) return;
  products.clear();
  for (const [id, value] of entries) {
    const product = normalizeProduct(value, id);
    if (product) products.set(id, product);
  }
  state.scope = scope();
  state.revision = message.revision;
  schedule();
});

function productId(article) {
  return article.dataset.testid?.match(/^ProductCardWrapper-(.+)$/)?.[1] || null;
}

function extractGrid() {
  const articles = [...document.querySelectorAll('article[data-testid^="ProductCardWrapper-"]')];
  const grid = articles[0]?.parentElement?.parentElement;
  if (!grid || articles.length < 2) return null;
  return {
    container: grid,
    models: articles.map((article) => {
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

function ensureControl() {
  return document.getElementById('lups-control') || createControl((action) => {
    if (action.type === 'restore') state.restored = true;
    else { state.dimension = action.dimension; state.direction = action.direction; state.restored = false; }
    scan();
  }, state);
}

function scan() {
  if (state.scope !== scope()) window.postMessage({ source: SOURCE, version: VERSION, type: 'api-products-request' }, location.origin);
  const grid = extractGrid();
  if (!grid) return;
  const control = ensureControl();
  if (!control) return;
  for (const model of grid.models) {
    if (!originalOrder.has(model.card)) originalOrder.set(model.card, [...grid.container.children].indexOf(model.card));
    if (model.dataSource === 'api') annotate(model);
    else model.productCard.querySelector('[data-lups-annotation]')?.remove();
  }
  if (state.restored) {
    for (const model of grid.models) model.card.style.removeProperty('order');
    updateStatus(control, { total: grid.models.length, restored: true });
    return;
  }
  const sorted = sortModels(grid.models, { dimension: state.dimension, direction: state.direction });
  sorted.items.forEach((model, index) => { model.card.style.order = String(index); });
  const sortable = grid.models.filter((model) => sorted.dimension === 'total' ? Number.isFinite(model.currentPrice)
    : model.dimension === sorted.dimension && Number.isFinite(model.normalizedUnitPrice)).length;
  const incompatible = sorted.dimension === 'total' ? 0 : grid.models.filter((model) => model.dimension
    && model.dimension !== sorted.dimension && Number.isFinite(model.normalizedUnitPrice)).length;
  updateStatus(control, { dimension: sorted.dimension, sortable, incompatible, unknown: grid.models.length - sortable - incompatible, total: grid.models.length });
}

function schedule() { clearTimeout(state.timer); state.timer = setTimeout(scan, 160); }
async function start() {
  if (!document.body) return;
  const result = await storage()?.sync?.get({ defaultSortMode: 'restore' }).catch(() => null);
  applyMode(result?.defaultSortMode);
  injectStyles();
  scan();
  new MutationObserver((records) => {
    if (!records.every((record) => record.target.closest?.('#lups-control,[data-lups-annotation]'))) schedule();
  }).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('scroll', schedule, { passive: true, capture: true });
  storage()?.onChanged?.addListener((changes, area) => {
    if (area !== 'sync' || !changes.defaultSortMode) return;
    applyMode(changes.defaultSortMode.newValue);
    document.getElementById('lups-control')?.remove();
    schedule();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
