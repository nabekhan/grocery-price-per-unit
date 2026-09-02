import { isSortableTotalPrice, sortModels } from '../../sorting/sort.js';
import { createControl, injectStyles, updateStatus } from '../../ui/control.js';
import { MAX_RENDERED_CARDS, readApiScanModel, readApiScanState } from './scan-state.js';
import { claimRuntimeInstall } from '../../runtime/install.js';
import { areOnlyOwnedMutations } from '../../runtime/mutations.js';
import { captureWaitState, createScanScheduler } from '../../runtime/retailer-lifecycle.js';

/*!
 * Walmart grid sorter. It consumes only bundle-private API-backed card models,
 * applies stable per-dimension order, and owns every display/order change
 * reversibly. Promotion hiding is restricted to explicitly classified search
 * ad siblings/wrappers; ambiguous nodes fail open.
 */

const state = { dimension: 'auto', direction: 'asc', restored: true };
const hiddenBySorter = new Map();
const originalOrders = new WeakMap();
const managedWrappers = new Set();
let lifecycle = null;
let scheduleScan = null;
let observer = null;
let isSearchPage = () => true;

function userscriptStorage() {
  return globalThis[Symbol.for('grocery-price-per-unit.storage.v1')]?.storage;
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

function findGrid(apiScan) {
  const cardNodes = document.querySelectorAll('[data-item-id]');
  if (cardNodes.length > MAX_RENDERED_CARDS) return null;
  const cards = [...cardNodes];
  const candidates = new Map();
  for (const card of cards) {
    let ancestor = card.parentElement;
    while (ancestor && ancestor !== document.body) {
      const wrapper = directChildUnder(card, ancestor);
      if (wrapper) {
        if (!candidates.has(ancestor)) candidates.set(ancestor, new Set());
        candidates.get(ancestor).add(wrapper);
      }
      ancestor = ancestor.parentElement;
    }
  }
  const ranked = [...candidates.entries()]
    .map(([grid, wrappers]) => ({
      grid,
      wrappers: [...wrappers],
      overlap: [...wrappers].filter((wrapper) => {
        const productCards = wrapper.matches('[data-item-id]') ? [wrapper] : [...wrapper.querySelectorAll('[data-item-id]')];
        return productCards.some((card) => readApiScanModel(apiScan, card)?.matched === true);
      }).length
    }))
    .filter((candidate) => candidate.wrappers.length >= 2)
    .sort((left, right) => right.overlap - left.overlap || right.wrappers.length - left.wrappers.length);
  if (!ranked.length) return null;
  const [selected, runnerUp] = ranked;
  if (ranked.length > 1 && selected.overlap === 0 && selected.wrappers.length === runnerUp.wrappers.length) return null;
  if (runnerUp && selected.overlap === runnerUp.overlap
    && selected.wrappers.length === runnerUp.wrappers.length) return null;
  return [selected.grid, selected.wrappers];
}

function hasRenderedBox(element) {
  if (!element) return false;
  const style = getComputedStyle(element);
  if (['none', 'hidden', 'collapse'].includes(style.display) || ['hidden', 'collapse'].includes(style.visibility)) return false;
  return [...element.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0);
}

function isRetailerPromotion(wrapper) {
  if (!wrapper || wrapper.matches('[data-item-id]') || wrapper.querySelector('[data-item-id]')) return false;
  return wrapper.matches(
    '[data-testid="tile-take-over"], [id^="search-MarqueeDisplayAd-"][id$="-ad-wrapper"]'
  );
}

function modelFor(wrapper, apiScan) {
  const cards = wrapper.matches('[data-item-id]') ? [wrapper] : [...wrapper.querySelectorAll('[data-item-id]')];
  const card = cards.find(hasRenderedBox) || cards[0] || null;
  const trusted = card ? readApiScanModel(apiScan, card) : null;
  return {
    card: wrapper,
    productCard: card,
    isProduct: Boolean(card),
    isPromotion: !card && isRetailerPromotion(wrapper),
    isVisible: hasRenderedBox(card),
    matched: trusted?.matched === true,
    normalizedUnitPrice: trusted?.normalizedUnitPrice ?? null,
    currentPrice: trusted?.currentPrice ?? null,
    dimension: trusted?.dimension ?? null
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

function rememberOrder(wrapper) {
  if (originalOrders.has(wrapper)) return;
  originalOrders.set(wrapper, {
    value: wrapper.style.getPropertyValue('order'),
    priority: wrapper.style.getPropertyPriority('order')
  });
}

function restoreOrder(wrapper) {
  const saved = originalOrders.get(wrapper);
  if (!saved) return;
  if (saved.value) wrapper.style.setProperty('order', saved.value, saved.priority);
  else wrapper.style.removeProperty('order');
  originalOrders.delete(wrapper);
}

function reconcileManagedWrappers(wrappers = []) {
  const current = new Set(wrappers);
  for (const wrapper of managedWrappers) {
    if (current.has(wrapper)) continue;
    restoreWrapperDisplay(wrapper);
    restoreOrder(wrapper);
    managedWrappers.delete(wrapper);
  }
  for (const wrapper of wrappers) managedWrappers.add(wrapper);
}

function ensureControl() {
  let control = document.getElementById('lups-control');
  if (control) return control;
  control = createControl((action) => {
    if (action.type === 'reload') return lifecycle?.reload();
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
  for (const [wrapper] of hiddenBySorter) restoreWrapperDisplay(wrapper);
  if (!isSearchPage()) {
    reconcileManagedWrappers();
    document.getElementById('lups-control')?.remove();
    return;
  }
  const apiScan = readApiScanState();
  const found = findGrid(apiScan);
  if (!found) {
    reconcileManagedWrappers();
    const existingControl = document.getElementById('lups-control');
    if (existingControl && !state.restored) updateStatus(existingControl, {
      total: undefined,
      dataState: captureWaitState(lifecycle)
    });
    return;
  }
  const [grid] = found;
  if (grid.children.length > MAX_RENDERED_CARDS) {
    reconcileManagedWrappers();
    const existingControl = document.getElementById('lups-control');
    if (existingControl && !state.restored) updateStatus(existingControl, {
      total: undefined,
      dataState: captureWaitState(lifecycle)
    });
    return;
  }
  const control = ensureControl();
  if (!control) return;
  const wrappers = [...grid.children];
  reconcileManagedWrappers(wrappers);
  const models = wrappers.map((wrapper) => modelFor(wrapper, apiScan));
  for (const model of models) {
    if (model.isPromotion) hideWrapper(model.card);
    if (model.isProduct && !model.isVisible && hasRenderedBox(model.card)) hideWrapper(model.card);
  }
  const visible = models.filter((model) => !model.isPromotion && (!model.isProduct || model.isVisible));
  const loaded = visible.filter((model) => model.isProduct).length;
  const excluded = models.filter((model) => model.isPromotion).length;
  if (state.restored) {
    for (const model of models) restoreOrder(model.card);
    updateStatus(control, { total: loaded, excluded, restored: true });
    return;
  }
  if (!apiScan || apiScan.accepted !== true) {
    for (const model of models) restoreOrder(model.card);
    updateStatus(control, {
      total: loaded,
      excluded,
      dataState: captureWaitState(lifecycle)
    });
    return;
  }
  if (apiScan.apiCards === 0 || !models.some((model) => model.matched)) {
    for (const model of models) restoreOrder(model.card);
    updateStatus(control, { total: loaded, excluded, dataState: 'no-match' });
    return;
  }
  const sorted = sortModels(visible, { dimension: state.dimension, direction: state.direction });
  sorted.items.forEach((model, index) => {
    rememberOrder(model.card);
    model.card.style.order = String(index);
  });
  const sortable = visible.filter((model) => model.isProduct && (sorted.dimension === 'total'
    ? isSortableTotalPrice(model.currentPrice)
    : model.dimension === sorted.dimension && Number.isFinite(model.normalizedUnitPrice))).length;
  const incompatible = sorted.dimension === 'total' ? 0 : visible.filter((model) => model.isProduct
    && model.dimension && model.dimension !== sorted.dimension && Number.isFinite(model.normalizedUnitPrice)).length;
  const unknown = loaded - sortable - incompatible;
  updateStatus(control, { dimension: sorted.dimension, sortable, incompatible, unknown, total: loaded, excluded, range: sorted.range });
}

function schedule(options) {
  return scheduleScan?.(options) || false;
}

function sorterNode(node) {
  const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  return Boolean(element?.matches?.('#lups-control, .price-per-unit-info, .ppu-walmart-icon, [data-lups-annotation]') ||
    element?.closest?.('#lups-control, .price-per-unit-info, .ppu-walmart-icon, [data-lups-annotation]'));
}

function sorterMutation(record) {
  if (sorterNode(record.target)) return true;
  const changedNodes = [...record.addedNodes, ...record.removedNodes];
  return changedNodes.length > 0 && changedNodes.every(sorterNode);
}

async function loadDefaultMode(storage) {
  if (!storage?.sync?.get) return 'restore';
  try {
    const value = await storage.sync.get({ defaultSortMode: 'restore' });
    return value?.defaultSortMode || 'restore';
  } catch {
    return 'restore';
  }
}

async function start() {
  if (!document.body) return;
  injectStyles();
  const storage = userscriptStorage();
  applyMode(await loadDefaultMode(storage));
  scan();
  window.addEventListener('ppu-products-updated', schedule);
  window.addEventListener('scroll', schedule, { passive: true, capture: true });
  window.addEventListener('resize', schedule, { passive: true });
  storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'sync' || !changes.defaultSortMode || !applyMode(changes.defaultSortMode.newValue)) return;
    document.getElementById('lups-control')?.remove();
    schedule();
  });
  observer = new MutationObserver((records) => {
    if (areOnlyOwnedMutations(records, sorterMutation)) return;
    schedule();
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'hidden', 'data-item-id'], childList: true, subtree: true });
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    observer?.disconnect();
    scheduleScan?.dispose();
  });
}

export function installWalmartSorter(context = {}) {
  if (!claimRuntimeInstall('walmart-sort')) return false;
  lifecycle = context.lifecycle || null;
  isSearchPage = typeof context.isSearchPage === 'function' ? context.isSearchPage : () => true;
  scheduleScan = createScanScheduler(window, scan, { delayMs: 150 });
  lifecycle?.subscribe(() => schedule({ urgent: true }));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
  return true;
}
