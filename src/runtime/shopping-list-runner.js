import { sortModels } from '../sorting/sort.js';

/*!
 * Shared shopping-list workflow.
 *
 * This module owns the reusable parts of an API-only cart run: parsing the
 * shopper's list, validating and persisting progress, presenting one compact
 * control, retrying temporarily unavailable operations, and producing a final
 * per-item report. Retailer code supplies verified product search, exact cart
 * mutation, cart reconciliation, and blocking-dialog detection.
 *
 * The runner never checks out, removes existing cart items, bypasses human
 * verification, or trusts persisted data without bounding it. A shopper must
 * explicitly preview a list and explicitly start its Add phase.
 */

// V7 deliberately invalidates candidates saved by the earlier page-navigation
// and price-only matching workflows, Walmart candidates saved before its
// retailer unit-price normalization was corrected, and optimistic Walmart
// updates that predated fresh-cart verification. An upgraded run must preview
// them again through the scoped API and shared relevance gate.
export const SHOPPING_RUN_STORAGE_KEY = 'shoppingListRunV7';
const RUN_VERSION = 7;
const MAX_ITEMS = 40;
const MAX_QUERY_LENGTH = 120;
const MAX_REASON_LENGTH = 240;
const ACTIVE_PHASES = new Set(['planning', 'adding', 'reviewing']);

const storage = () => globalThis[Symbol.for('grocery-price-per-unit.storage.v1')]?.storage;
const boundedText = (value, maximum) => typeof value === 'string'
  ? value.trim().normalize('NFKC').replace(/\s+/g, ' ').slice(0, maximum) || null
  : null;

export function parseShoppingList(value) {
  if (typeof value !== 'string') return [];
  return value.split(',')
    .map((part) => boundedText(part, MAX_QUERY_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_ITEMS);
}

function normalizedCandidate(value) {
  if (!value || typeof value !== 'object') return null;
  const productId = boundedText(value.productId, 160);
  const name = boundedText(value.name, 1_500);
  const currentPrice = Number.isFinite(value.currentPrice) && value.currentPrice > 0
    ? Math.min(value.currentPrice, 1_000_000)
    : null;
  const normalizedUnitPrice = Number.isFinite(value.normalizedUnitPrice) && value.normalizedUnitPrice > 0
    ? Math.min(value.normalizedUnitPrice, 1_000_000_000)
    : null;
  const dimension = ['mass', 'volume', 'count'].includes(value.dimension) ? value.dimension : null;
  if (!productId || !name || currentPrice === null) return null;
  return { productId, name, currentPrice, normalizedUnitPrice, dimension };
}

function searchWords(value) {
  return String(value || '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

function singularWord(word) {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

function queryMatchTier(name, query) {
  const queryTokens = searchWords(query);
  const nameTokens = searchWords(name);
  if (!queryTokens.length || !nameTokens.length) return 0;
  if (` ${nameTokens.join(' ')} `.includes(` ${queryTokens.join(' ')} `)) return 3;
  const exact = new Set(nameTokens);
  if (queryTokens.every((token) => exact.has(token))) return 2;
  const singular = new Set(nameTokens.map(singularWord));
  return queryTokens.every((token) => singular.has(singularWord(token))) ? 1 : 0;
}

export function chooseCheapestProduct(products, mode = 'unit', query = '') {
  const eligible = (Array.isArray(products) ? products : [])
    .filter((product) => product?.matched === true && product?.addable === true)
    .map((product, index) => ({
      candidate: normalizedCandidate(product), index,
      matchTier: queryMatchTier(product?.name, query)
    }))
    .filter(({ candidate }) => Boolean(candidate));
  if (!eligible.length) return null;
  const bestTier = Math.max(...eligible.map(({ matchTier }) => matchTier));
  // First compare products that match the shopper's words equally well. If a
  // retailer returns conceptual/category matches only (for example “baguette”
  // for “bread”), retain a bounded relevance-ordered window rather than
  // treating every loosely related search hit as the requested item.
  const candidates = (bestTier > 0
    ? eligible.filter(({ matchTier }) => matchTier === bestTier)
    : eligible.slice(0, 12))
    .sort((left, right) => left.index - right.index)
    .map(({ candidate }) => candidate);
  const sorted = sortModels(candidates, {
    dimension: mode === 'total' ? 'total' : 'auto',
    direction: 'asc'
  });
  const selected = sorted.items[0];
  return selected ? Object.freeze({
    ...normalizedCandidate(selected),
    selectedBy: sorted.dimension
  }) : null;
}

function normalizedItem(value) {
  if (!value || typeof value !== 'object') return null;
  const query = boundedText(value.query, MAX_QUERY_LENGTH);
  const allowedStatus = new Set([
    'pending', 'collecting', 'planned', 'adding', 'added', 'missed',
    'missing-from-cart', 'verification-unavailable'
  ]);
  if (!query || !allowedStatus.has(value.status)) return null;
  return {
    query,
    status: value.status,
    candidate: normalizedCandidate(value.candidate),
    selectedBy: ['mass', 'volume', 'count', 'total'].includes(value.selectedBy) ? value.selectedBy : null,
    reason: boundedText(value.reason, MAX_REASON_LENGTH),
    priceChanged: value.priceChanged === true
  };
}

function normalizedRun(value, retailerId) {
  if (!value || typeof value !== 'object' || value.version !== RUN_VERSION
    || value.retailerId !== retailerId || !Array.isArray(value.items)
    || value.items.length < 1 || value.items.length > MAX_ITEMS) return null;
  const items = value.items.map(normalizedItem);
  if (items.some((item) => !item)) return null;
  const phases = new Set(['planning', 'ready-to-add', 'adding', 'reviewing', 'paused', 'complete']);
  if (!phases.has(value.phase)) return null;
  return {
    version: RUN_VERSION,
    retailerId,
    phase: value.phase,
    resumePhase: ['planning', 'adding', 'reviewing'].includes(value.resumePhase) ? value.resumePhase : null,
    // Cart runs always follow the project's unit-price-first contract. The
    // field remains serialized for forward compatibility, not as a UI choice.
    mode: 'unit',
    currentIndex: Number.isSafeInteger(value.currentIndex)
      ? Math.max(0, Math.min(value.currentIndex, items.length))
      : 0,
    items,
    // Completed successful runs need no announcement; the item rows already
    // show the result. This also removes completion prose saved by older builds.
    message: value.phase === 'complete'
      && items.every((item) => !['missed', 'missing-from-cart'].includes(item.status))
      ? null
      : boundedText(value.message, MAX_REASON_LENGTH),
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now()
  };
}

function formatMoney(value) {
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : 'price unavailable';
}

function unitSuffix(dimension) {
  return { mass: '/kg', volume: '/L', count: '/each' }[dimension] || '';
}

let adoptedShoppingStyleSheet = null;
const shoppingStyleText = `
    #gppu-shopping-assistant{position:fixed!important;z-index:2147483645!important;right:max(18px,env(safe-area-inset-right))!important;bottom:calc(max(18px,env(safe-area-inset-bottom)) + 64px)!important;font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;color:#273244!important}
    #gppu-shopping-assistant[data-gppu-standalone="true"]{bottom:max(18px,env(safe-area-inset-bottom))!important}
    #gppu-shopping-toggle{box-sizing:border-box!important;display:grid!important;width:50px!important;height:50px!important;margin-left:auto!important;place-items:center!important;border:0!important;border-radius:999px!important;background:#fffffff5!important;color:#334155!important;box-shadow:0 5px 16px #0f172a1f,0 1px 3px #0f172a1a!important;font-size:22px!important}
    #gppu-shopping-toggle:hover{background:#f8fafc!important;transform:translateY(-1px)!important}
    #gppu-shopping-toggle[hidden]{display:none!important}
    #gppu-shopping-toggle svg{width:25px!important;height:25px!important}
    #lups-control .lups-trigger-row:has(>#gppu-shopping-toggle[data-gppu-quick-action="true"]){position:relative!important}
    #lups-control .lups-trigger-row:has(>#gppu-shopping-toggle[data-gppu-quick-action="true"])::before{position:absolute!important;right:100%!important;bottom:0!important;width:58px!important;height:50px!important;content:""!important}
    #lups-control .lups-trigger-row:has(>#lups-flip-direction:not([hidden])):has(>#gppu-shopping-toggle[data-gppu-quick-action="true"])::before{width:116px!important}
    #lups-control #gppu-shopping-toggle[data-gppu-quick-action="true"]{position:absolute!important;z-index:2!important;right:calc(100% + 8px)!important;bottom:0!important;margin:0!important;opacity:0!important;visibility:hidden!important;pointer-events:none!important;transform:translateX(10px) scale(.92)!important;transition:opacity .12s ease,transform .12s ease,visibility .12s ease,box-shadow .16s ease,background .16s ease!important}
    #lups-control .lups-trigger-row:has(>#lups-flip-direction:not([hidden]))>#gppu-shopping-toggle[data-gppu-quick-action="true"]{right:calc(100% + 66px)!important}
    #lups-control[data-lups-menu-open="false"] .lups-trigger-row:hover>#gppu-shopping-toggle[data-gppu-quick-action="true"],#lups-control[data-lups-menu-open="false"] .lups-trigger-row:focus-within>#gppu-shopping-toggle[data-gppu-quick-action="true"]{opacity:1!important;visibility:visible!important;pointer-events:auto!important;transform:none!important}
    #gppu-shopping-panel{box-sizing:border-box!important;position:relative!important;width:min(390px,calc(100vw - 24px))!important;max-height:min(72vh,620px)!important;margin-bottom:10px!important;padding:16px!important;overflow:auto!important;border:1px solid #d7dee8!important;border-radius:18px!important;background:#fffffff8!important;box-shadow:0 18px 50px #0f172a35!important;backdrop-filter:blur(12px)!important}
    #gppu-shopping-panel[hidden]{display:none!important}
    #gppu-shopping-panel label{display:block!important;margin:0 0 5px!important;font-weight:700!important}
    #gppu-shopping-input{box-sizing:border-box!important;width:100%!important;border:1px solid #cbd5e1!important;border-radius:10px!important;background:#fff!important;color:#1f2937!important;font:inherit!important}
    #gppu-shopping-input{min-height:78px!important;padding:9px 10px!important;resize:vertical!important}
    .gppu-shopping-actions{display:flex!important;flex-wrap:wrap!important;gap:8px!important;margin-top:12px!important}
    .gppu-shopping-actions button{min-height:42px!important;padding:0 13px!important;border:1px solid #27364a!important;border-radius:999px!important;background:#27364a!important;color:#fff!important;font:700 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important}
    .gppu-shopping-actions button[data-secondary="true"]{border-color:#cbd5e1!important;background:#fff!important;color:#334155!important}
    #gppu-shopping-status{margin:12px 0 8px!important;padding:9px 10px!important;border-radius:10px!important;background:#eef2f7!important;color:#364152!important;font-weight:650!important}
    #gppu-shopping-status[hidden]{display:none!important}
    #gppu-shopping-results{display:grid!important;gap:7px!important;margin:0!important;padding:0!important;list-style:none!important}
    #gppu-shopping-results li{padding:8px 9px!important;border:1px solid #e2e8f0!important;border-radius:10px!important;background:#fff!important}
    #gppu-shopping-results strong{display:block!important;color:#263244!important}
    #gppu-shopping-results small{display:block!important;margin-top:2px!important;color:#64748b!important}
    #gppu-shopping-assistant :focus-visible{outline:3px solid #6476b8!important;outline-offset:2px!important}
    @media(max-width:640px){#gppu-shopping-assistant{right:max(10px,env(safe-area-inset-right))!important;bottom:calc(max(14px,env(safe-area-inset-bottom)) + 62px)!important}#gppu-shopping-assistant[data-gppu-standalone="true"]{bottom:max(14px,env(safe-area-inset-bottom))!important}#gppu-shopping-panel{width:calc(100vw - 20px)!important}}
    @media(forced-colors:active){#gppu-shopping-toggle{border:2px solid CanvasText!important;background:Canvas!important;color:CanvasText!important;box-shadow:none!important}#gppu-shopping-assistant :focus-visible{outline-color:Highlight!important}}
    @media(prefers-reduced-motion:reduce){#gppu-shopping-toggle{transition:none!important}}
  `;

function injectShoppingStyles() {
  // Constructed stylesheets are the primary Safari path: unlike an injected
  // <style>, they remain usable when a retailer declares style-src 'none'. The
  // element fallback is reserved for older engines without CSSStyleSheet.
  if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in document) {
    try {
      if (!adoptedShoppingStyleSheet) {
        adoptedShoppingStyleSheet = new CSSStyleSheet();
        adoptedShoppingStyleSheet.replaceSync(shoppingStyleText);
      }
      if (!document.adoptedStyleSheets.includes(adoptedShoppingStyleSheet)) {
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, adoptedShoppingStyleSheet];
      }
      return;
    } catch {
      adoptedShoppingStyleSheet = null;
    }
  }
  if (document.getElementById('gppu-shopping-styles')) return;
  const style = document.createElement('style');
  style.id = 'gppu-shopping-styles';
  style.textContent = shoppingStyleText;
  document.head?.append(style);
}

export function createShoppingListRunner({ retailerId, adapter }) {
  if (!retailerId || !adapter) throw new TypeError('Shopping-list runner requires a retailer adapter');
  let run = null;
  let busy = false;
  let root = null;
  let panel = null;
  let input = null;
  let status = null;
  let results = null;
  let actions = null;
  let toggle = null;
  let launcherObserver = null;

  function cartIcon() {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    // A centered bag reads as shopping without the visual lean of a trolley,
    // keeping this action balanced beside the menu's one-character glyphs.
    icon.innerHTML = '<path d="M5.5 8.5h13l-1 11h-11l-1-11Z M9 8.5V6.75a3 3 0 0 1 6 0V8.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"/>';
    return icon;
  }

  function setPanelOpen(open, { focus = false } = {}) {
    panel.hidden = !open;
    toggle?.setAttribute('aria-expanded', String(open));
    toggle?.setAttribute('aria-label', open ? 'Close cart builder' : 'Open cart builder');
    if (open && focus) window.setTimeout(() => input?.focus(), 0);
  }

  /*
   * On a results page the cart launcher is a quick action that reveals itself
   * to the left of the main sort button on pointer hover or keyboard focus.
   * During cart review (where the sorter is intentionally absent) the same
   * button returns to its standalone position so a run remains resumable.
   */
  function syncLauncherPlacement() {
    if (!root?.isConnected) return;
    injectShoppingStyles();
    const triggerRow = document.querySelector('#lups-control .lups-trigger-row');
    if (!triggerRow) {
      if (toggle.parentElement !== root) root.append(toggle);
      delete toggle.dataset.gppuQuickAction;
      root.dataset.gppuStandalone = 'true';
      toggle.hidden = false;
      return;
    }
    delete root.dataset.gppuStandalone;
    toggle.hidden = false;
    toggle.dataset.gppuQuickAction = 'true';
    if (toggle.parentElement !== triggerRow) triggerRow.append(toggle);
  }

  async function readRun() {
    try {
      const value = await storage()?.local?.get({ [SHOPPING_RUN_STORAGE_KEY]: null });
      return normalizedRun(value?.[SHOPPING_RUN_STORAGE_KEY], retailerId);
    } catch {
      return null;
    }
  }

  async function saveRun() {
    if (!run) return;
    run.updatedAt = Date.now();
    try { await storage()?.local?.set?.({ [SHOPPING_RUN_STORAGE_KEY]: run }); } catch { /* resume is best effort */ }
  }

  async function clearRun() {
    run = null;
    try { await storage()?.local?.remove?.(SHOPPING_RUN_STORAGE_KEY); } catch { /* UI can still reset */ }
  }

  function actionButton(label, handler, secondary = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (secondary) button.dataset.secondary = 'true';
    button.addEventListener('click', handler);
    actions.append(button);
  }

  function describeItem(item) {
    if (item.candidate) {
      const unit = Number.isFinite(item.candidate.normalizedUnitPrice)
        ? ` · ${formatMoney(item.candidate.normalizedUnitPrice)}${unitSuffix(item.candidate.dimension)}`
        : '';
      const note = item.reason ? ` · ${item.reason}` : '';
      return `${item.candidate.name} · ${formatMoney(item.candidate.currentPrice)}${unit}${note}`;
    }
    return item.reason || ({ pending: 'Waiting', collecting: 'Loading search results', adding: 'Adding to cart' }[item.status] || item.status);
  }

  function render() {
    if (!root) return;
    actions.textContent = '';
    results.textContent = '';
    if (!run) {
      status.hidden = true;
      status.textContent = '';
      actionButton('Preview items', startPlanning);
      return;
    }
    input.value = run.items.map((item) => item.query).join(', ');
    input.disabled = true;
    const statusMessage = run.message || ({
      planning: `Planning item ${Math.min(run.currentIndex + 1, run.items.length)} of ${run.items.length}`,
      'ready-to-add': '',
      adding: `Adding item ${Math.min(run.currentIndex + 1, run.items.length)} of ${run.items.length}`,
      reviewing: 'Reviewing the added products in your cart',
      paused: 'Paused for your attention',
      complete: ''
    }[run.phase]);
    status.textContent = statusMessage;
    status.hidden = !statusMessage;
    for (const item of run.items) {
      const row = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = item.status === 'planned'
        ? item.query
        : `${item.query} — ${item.status.replaceAll('-', ' ')}`;
      const detail = document.createElement('small');
      detail.textContent = describeItem(item);
      row.append(title, detail);
      results.append(row);
    }
    if (run.phase === 'ready-to-add') actionButton('Add', startAdding);
    if (run.phase === 'paused') actionButton('Retry', continueRun);
    if (run.phase === 'complete') actionButton('Start another list', resetRun);
    actionButton('Cancel', cancelRun, true);
  }

  async function pause(reason, resumePhase) {
    run.phase = 'paused';
    run.resumePhase = resumePhase;
    run.message = boundedText(reason, MAX_REASON_LENGTH) || 'The run needs your attention.';
    await saveRun();
    render();
  }

  async function startPlanning() {
    const queries = parseShoppingList(input.value);
    if (!queries.length) {
      status.textContent = 'Enter at least one item, separated by commas.';
      return;
    }
    run = {
      version: RUN_VERSION,
      retailerId,
      phase: 'planning',
      resumePhase: null,
      mode: 'unit',
      currentIndex: 0,
      items: queries.map((query) => ({
        query, status: 'pending', candidate: null, selectedBy: null,
        reason: null, priceChanged: false
      })),
      message: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    panel.hidden = false;
    await saveRun();
    render();
    void advance();
  }

  async function startAdding() {
    run.phase = 'adding';
    run.currentIndex = 0;
    run.message = 'Adding items';
    await saveRun();
    render();
    void advance();
  }

  async function continueRun() {
    run.phase = run.resumePhase || 'planning';
    run.resumePhase = null;
    run.message = null;
    await saveRun();
    render();
    void advance();
  }

  async function resetRun() {
    await clearRun();
    input.disabled = false;
    input.value = '';
    render();
  }

  async function cancelRun() {
    await clearRun();
    input.disabled = false;
    render();
  }

  async function advancePlanning() {
    const item = run.items[run.currentIndex];
    if (!item) {
      run.phase = 'ready-to-add';
      run.message = null;
      await saveRun();
      render();
      return;
    }
    const blocked = adapter.blockingReason?.();
    if (blocked) return pause(blocked, 'planning');
    // Product discovery is API-only. If a retailer cannot answer this query,
    // retain the current item and current document so a later retry is safe.
    item.status = 'collecting';
    run.message = `Finding “${item.query}”`;
    await saveRun();
    render();
    const queried = await adapter.queryProducts(item.query, {
      onProgress: (message) => {
        run.message = boundedText(message, MAX_REASON_LENGTH);
        render();
      }
    });
    if (queried?.status === 'human-required') {
      item.status = 'pending';
      return pause(queried.reason, 'planning');
    }
    if (queried?.status !== 'complete' || !Array.isArray(queried.products)) {
      item.status = 'pending';
      return pause(
        queried?.reason || adapter.searchUnavailableReason
          || `${adapter.retailerName || 'Retailer'} search API is unavailable.`,
        'planning'
      );
    }
    const chosen = chooseCheapestProduct(queried.products, run.mode, item.query);
    if (chosen) {
      item.status = 'planned';
      item.candidate = normalizedCandidate(chosen);
      item.selectedBy = chosen.selectedBy;
      item.reason = null;
    } else {
      item.status = 'missed';
      item.reason = 'No in-stock, verified product was returned.';
    }
    run.currentIndex += 1;
    run.message = null;
    await saveRun();
    render();
    return advancePlanning();
  }

  async function advanceAdding() {
    const item = run.items[run.currentIndex];
    if (!item) {
      run.phase = 'reviewing';
      run.currentIndex = 0;
      run.message = 'Reviewing cart';
      await saveRun();
      render();
      return advanceReview();
    }
    if (!item.candidate || item.status === 'missed') {
      run.currentIndex += 1;
      await saveRun();
      return advanceAdding();
    }
    const blocked = adapter.blockingReason?.();
    if (blocked) return pause(blocked, 'adding');
    // Cart mutation is API-only. A null result means the retailer plugin could
    // not verify the current cart/session, so remain in place and allow retry.
    item.status = 'adding';
    run.message = `Adding ${item.candidate.name}`;
    await saveRun();
    render();
    const direct = await adapter.directAddProduct?.(item.candidate, {
      onProgress: (message) => { run.message = boundedText(message, MAX_REASON_LENGTH); render(); }
    });
    if (direct?.status === 'human-required') {
      item.status = 'planned';
      return pause(direct.reason, 'adding');
    }
    if (direct?.status === 'added') {
      item.status = 'added';
      item.priceChanged = direct.priceChanged === true;
      item.reason = direct.alreadyPresent === true
        ? 'This exact product was already represented in the cart, so it was not added twice.'
        : item.priceChanged ? 'Price changed after preview; the current product was added.' : null;
      run.currentIndex += 1;
      run.message = null;
      await saveRun();
      render();
      return advanceAdding();
    }
    if (direct && direct.status !== 'unavailable') {
      item.status = 'missed';
      item.reason = boundedText(direct.reason, MAX_REASON_LENGTH) || 'The cart API did not confirm this item.';
      run.currentIndex += 1;
      run.message = null;
      await saveRun();
      render();
      return advanceAdding();
    }
    item.status = 'planned';
    return pause(
      direct?.reason || adapter.cartUnavailableReason
        || `${adapter.retailerName || 'Retailer'} cart API is unavailable.`,
      'adding'
    );
  }

  async function advanceReview() {
    const added = run.items.filter((item) => item.status === 'added' && item.candidate);
    // Review is API-only. Do not open the cart page merely to scrape it.
    const directReview = await adapter.directReviewCart?.(added.map((item) => item.candidate));
    if (directReview) return finishReview(directReview, added);
    return pause(
      adapter.cartUnavailableReason
        || `${adapter.retailerName || 'Retailer'} cart review API is unavailable.`,
      'reviewing'
    );
  }

  async function finishReview(review, added) {
    if (review?.blockingReason) return pause(review.blockingReason, 'reviewing');
    if (review?.inspectable) {
      const present = new Set(review.presentProductIds || []);
      for (const item of added) {
        if (!present.has(item.candidate.productId)) {
          item.status = 'missing-from-cart';
          item.reason = 'The Add step appeared successful, but this product was not found during cart review.';
        }
      }
    } else {
      for (const item of added) {
        item.status = 'verification-unavailable';
        item.reason = `Added successfully, but ${adapter.retailerName || 'the retailer'} did not expose stable product IDs for final cart verification.`;
      }
    }
    run.phase = 'complete';
    run.currentIndex = run.items.length;
    const missed = run.items.filter((item) => ['missed', 'missing-from-cart'].includes(item.status)).length;
    run.message = missed
      ? `${missed} item${missed === 1 ? '' : 's'} need attention.`
      : null;
    await saveRun();
    render();
  }

  async function advance() {
    if (busy || !run || !ACTIVE_PHASES.has(run.phase)) return;
    busy = true;
    try {
      if (run.phase === 'planning') await advancePlanning();
      else if (run.phase === 'adding') await advanceAdding();
      else if (run.phase === 'reviewing') await advanceReview();
    } catch (error) {
      await pause(`Paused after an unexpected page change: ${String(error?.message || error).slice(0, 160)}`, run.phase);
    } finally {
      busy = false;
    }
  }

  async function mount() {
    if (!document.body || document.getElementById('gppu-shopping-assistant')) return;
    injectShoppingStyles();
    root = document.createElement('aside');
    root.id = 'gppu-shopping-assistant';
    root.setAttribute('aria-label', 'Shopping list cart assistant');
    panel = document.createElement('section');
    panel.id = 'gppu-shopping-panel';
    panel.setAttribute('aria-label', 'Shopping list');
    panel.hidden = true;
    const inputLabel = document.createElement('label');
    inputLabel.htmlFor = 'gppu-shopping-input';
    inputLabel.textContent = 'Shopping list';
    input = document.createElement('textarea');
    input.id = 'gppu-shopping-input';
    input.placeholder = 'Peanut butter, bananas, jelly, water';
    status = document.createElement('div');
    status.id = 'gppu-shopping-status';
    status.setAttribute('aria-live', 'polite');
    results = document.createElement('ul');
    results.id = 'gppu-shopping-results';
    actions = document.createElement('div');
    actions.className = 'gppu-shopping-actions';
    panel.append(inputLabel, input, status, results, actions);
    toggle = document.createElement('button');
    toggle.id = 'gppu-shopping-toggle';
    toggle.type = 'button';
    toggle.append(cartIcon());
    toggle.setAttribute('aria-label', 'Open cart builder');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', () => {
      setPanelOpen(panel.hidden, { focus: panel.hidden });
    });
    root.append(panel, toggle);
    document.body.append(root);
    launcherObserver = new MutationObserver(syncLauncherPlacement);
    launcherObserver.observe(document.body, { childList: true, subtree: true });
    syncLauncherPlacement();
    run = await readRun();
    if (run) {
      setPanelOpen(true);
    }
    render();
    if (run && ACTIVE_PHASES.has(run.phase)) window.setTimeout(() => void advance(), 350);
    window.addEventListener('pagehide', () => launcherObserver?.disconnect(), { once: true });
  }

  return Object.freeze({
    install() {
      if (document.body) void mount();
      else document.addEventListener('DOMContentLoaded', () => void mount(), { once: true });
    }
  });
}
