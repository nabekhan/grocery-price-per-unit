import { sortModels } from '../../sorting/sort.js';
import { createControl, injectStyles, updateStatus } from '../../ui/control.js';

const state = { dimension: 'auto', direction: 'asc', restored: true, timer: null };
const hiddenBySorter = new WeakMap();
const originalIndexes = new WeakMap();
let nextOriginalIndex = 0;

function extensionStorage() {
  return globalThis.browser?.storage || globalThis.chrome?.storage;
}

function applyMode(value = 'restore') {
  if (value === 'restore') {
    state.restored = true;
    return true;
  }
  const match = /^(auto|mass|volume|count|total)-(asc|desc)$/.exec(value);
  if (!match) return false;
  [, state.dimension, state.direction] = match;
  state.restored = false;
  return true;
}

function directChildUnder(node, ancestor) {
  let child = node;
  while (child?.parentElement && child.parentElement !== ancestor) child = child.parentElement;
  return child?.parentElement === ancestor ? child : null;
}

function findGrid() {
  const cards = [...document.querySelectorAll('[data-item-id]')];
  const candidates = new Map();
  for (const card of cards) {
    let ancestor = card.parentElement;
    while (ancestor && ancestor !== document.body) {
      const wrappers = [...new Set(cards.map((item) => directChildUnder(item, ancestor)).filter(Boolean))];
      if (wrappers.length >= 2 && wrappers.length > (candidates.get(ancestor)?.length || 0)) candidates.set(ancestor, wrappers);
      ancestor = ancestor.parentElement;
    }
  }
  return [...candidates.entries()].sort((a, b) => b[1].length - a[1].length)[0] || null;
}

function hasRenderedBox(element) {
  if (!element) return false;
  const style = getComputedStyle(element);
  if (['none', 'hidden', 'collapse'].includes(style.display) || ['hidden', 'collapse'].includes(style.visibility)) return false;
  return [...element.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0);
}

function modelFor(wrapper) {
  const cards = wrapper.matches('[data-item-id]') ? [wrapper] : [...wrapper.querySelectorAll('[data-item-id]')];
  const card = cards.find(hasRenderedBox) || cards[0] || null;
  const normalizedUnitPrice = Number(card?.dataset.ppuSortValue);
  const currentPrice = Number(card?.dataset.ppuTotalPrice);
  return {
    card: wrapper,
    productCard: card,
    isProduct: Boolean(card),
    isVisible: hasRenderedBox(card),
    normalizedUnitPrice: Number.isFinite(normalizedUnitPrice) && normalizedUnitPrice >= 0 ? normalizedUnitPrice : null,
    currentPrice: Number.isFinite(currentPrice) && currentPrice >= 0 ? currentPrice : null,
    dimension: card?.dataset.ppuSortDimension || null
  };
}

function hideWrapper(wrapper) {
  if (!hiddenBySorter.has(wrapper)) {
    hiddenBySorter.set(wrapper, {
      value: wrapper.style.getPropertyValue('display'),
      priority: wrapper.style.getPropertyPriority('display')
    });
  }
  wrapper.style.setProperty('display', 'none', 'important');
}

function restoreWrapperDisplay(wrapper) {
  const saved = hiddenBySorter.get(wrapper);
  if (!saved) return;
  if (saved.value) wrapper.style.setProperty('display', saved.value, saved.priority);
  else wrapper.style.removeProperty('display');
  hiddenBySorter.delete(wrapper);
}

function ensureControl() {
  let control = document.getElementById('lups-control');
  if (control) return control;
  control = createControl((action) => {
    if (action.type === 'restore') state.restored = true;
    else {
      state.dimension = action.dimension;
      state.direction = action.direction;
      state.restored = false;
    }
    scan();
  }, state);
  return control;
}

function scan() {
  const found = findGrid();
  if (!found) return;
  const [grid] = found;
  const control = ensureControl();
  if (!control) return;
  const wrappers = [...grid.children];
  for (const wrapper of wrappers) {
    restoreWrapperDisplay(wrapper);
    if (!originalIndexes.has(wrapper)) originalIndexes.set(wrapper, nextOriginalIndex++);
  }
  const models = wrappers.map(modelFor);
  for (const model of models) {
    if (model.isProduct && !model.isVisible && hasRenderedBox(model.card)) hideWrapper(model.card);
  }
  const visible = models.filter((model) => !model.isProduct || model.isVisible);
  const loaded = visible.filter((model) => model.isProduct).length;
  if (state.restored) {
    for (const model of models) model.card.style.removeProperty('order');
    updateStatus(control, { total: loaded, restored: true });
    return;
  }
  const sorted = sortModels(visible, { dimension: state.dimension, direction: state.direction });
  sorted.items.forEach((model, index) => { model.card.style.order = String(index); });
  const sortable = visible.filter((model) => model.isProduct && (sorted.dimension === 'total'
    ? Number.isFinite(model.currentPrice)
    : model.dimension === sorted.dimension && Number.isFinite(model.normalizedUnitPrice))).length;
  const incompatible = sorted.dimension === 'total' ? 0 : visible.filter((model) => model.isProduct
    && model.dimension && model.dimension !== sorted.dimension && Number.isFinite(model.normalizedUnitPrice)).length;
  const unknown = loaded - sortable - incompatible;
  updateStatus(control, { dimension: sorted.dimension, sortable, incompatible, unknown, total: loaded });
}

function schedule() {
  clearTimeout(state.timer);
  state.timer = setTimeout(scan, 150);
}

function start() {
  if (!document.body) return;
  injectStyles();
  const storage = extensionStorage();
  storage?.sync?.get({ defaultSortMode: 'restore' }, (result) => {
    applyMode(result.defaultSortMode);
    scan();
  });
  if (!storage?.sync) scan();
  window.addEventListener('ppu-products-updated', scan);
  window.addEventListener('scroll', schedule, { passive: true, capture: true });
  window.addEventListener('resize', schedule, { passive: true });
  storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'sync' || !changes.defaultSortMode || !applyMode(changes.defaultSortMode.newValue)) return;
    document.getElementById('lups-control')?.remove();
    schedule();
  });
  const observer = new MutationObserver((records) => {
    if (records.every((record) => record.target.closest?.('#lups-control,.price-per-unit-info,.ppu-walmart-icon'))) return;
    schedule();
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'hidden', 'data-item-id'], childList: true, subtree: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
