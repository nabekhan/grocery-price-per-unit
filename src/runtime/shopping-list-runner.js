import { sortModels } from '../sorting/sort.js';

/*!
 * Shared shopping-list workflow.
 *
 * This module owns the reusable parts of a multi-page cart run: parsing the
 * shopper's list, validating and persisting progress, presenting one compact
 * control, resuming after navigation, and producing a final per-item report.
 * Retailer code supplies search URLs, product collection, exact Add-button
 * behavior, blocking-dialog detection, and cart reconciliation.
 *
 * The runner never checks out, removes existing cart items, bypasses human
 * verification, or trusts persisted data without bounding it. A shopper must
 * explicitly preview a list and explicitly start its Add phase.
 */

export const SHOPPING_RUN_STORAGE_KEY = 'shoppingListRunV1';
const RUN_VERSION = 1;
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

export function chooseCheapestProduct(products, mode = 'unit') {
  const candidates = (Array.isArray(products) ? products : [])
    .filter((product) => product?.matched === true && product?.addable === true)
    .map(normalizedCandidate)
    .filter(Boolean);
  if (!candidates.length) return null;
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
    mode: value.mode === 'total' ? 'total' : 'unit',
    currentIndex: Number.isSafeInteger(value.currentIndex)
      ? Math.max(0, Math.min(value.currentIndex, items.length))
      : 0,
    items,
    message: boundedText(value.message, MAX_REASON_LENGTH),
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

function injectShoppingStyles() {
  if (document.getElementById('gppu-shopping-styles')) return;
  const style = document.createElement('style');
  style.id = 'gppu-shopping-styles';
  style.textContent = `
    #gppu-shopping-assistant{position:fixed!important;z-index:2147483645!important;right:max(18px,env(safe-area-inset-right))!important;bottom:calc(max(18px,env(safe-area-inset-bottom)) + 64px)!important;font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;color:#273244!important}
    #gppu-shopping-toggle{box-sizing:border-box!important;display:grid!important;width:50px!important;height:50px!important;margin-left:auto!important;place-items:center!important;border:1px solid #1e293b!important;border-radius:999px!important;background:#fff!important;color:#27364a!important;box-shadow:0 9px 24px #0f172a2e,0 2px 6px #0f172a20!important;font-size:22px!important}
    #gppu-shopping-toggle:hover{background:#f8fafc!important;transform:translateY(-1px)!important}
    #gppu-shopping-toggle svg{width:25px!important;height:25px!important}
    #gppu-shopping-panel{box-sizing:border-box!important;width:min(390px,calc(100vw - 24px))!important;max-height:min(72vh,620px)!important;margin-bottom:10px!important;padding:16px!important;overflow:auto!important;border:1px solid #d7dee8!important;border-radius:18px!important;background:#fffffff8!important;box-shadow:0 18px 50px #0f172a35!important;backdrop-filter:blur(12px)!important}
    #gppu-shopping-panel[hidden]{display:none!important}
    #gppu-shopping-panel h2{margin:0!important;font-size:18px!important;letter-spacing:-.02em!important}
    #gppu-shopping-panel p{margin:6px 0 12px!important;color:#5b6777!important}
    #gppu-shopping-panel label{display:block!important;margin:10px 0 5px!important;font-weight:700!important}
    #gppu-shopping-input,#gppu-shopping-mode{box-sizing:border-box!important;width:100%!important;border:1px solid #cbd5e1!important;border-radius:10px!important;background:#fff!important;color:#1f2937!important;font:inherit!important}
    #gppu-shopping-input{min-height:78px!important;padding:9px 10px!important;resize:vertical!important}
    #gppu-shopping-mode{height:42px!important;padding:0 9px!important}
    .gppu-shopping-actions{display:flex!important;flex-wrap:wrap!important;gap:8px!important;margin-top:12px!important}
    .gppu-shopping-actions button{min-height:42px!important;padding:0 13px!important;border:1px solid #27364a!important;border-radius:999px!important;background:#27364a!important;color:#fff!important;font:700 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important}
    .gppu-shopping-actions button[data-secondary="true"]{border-color:#cbd5e1!important;background:#fff!important;color:#334155!important}
    #gppu-shopping-status{margin:12px 0 8px!important;padding:9px 10px!important;border-radius:10px!important;background:#eef2f7!important;color:#364152!important;font-weight:650!important}
    #gppu-shopping-results{display:grid!important;gap:7px!important;margin:0!important;padding:0!important;list-style:none!important}
    #gppu-shopping-results li{padding:8px 9px!important;border:1px solid #e2e8f0!important;border-radius:10px!important;background:#fff!important}
    #gppu-shopping-results strong{display:block!important;color:#263244!important}
    #gppu-shopping-results small{display:block!important;margin-top:2px!important;color:#64748b!important}
    #gppu-shopping-assistant :focus-visible{outline:3px solid #6476b8!important;outline-offset:2px!important}
    @media(max-width:640px){#gppu-shopping-assistant{right:max(10px,env(safe-area-inset-right))!important;bottom:calc(max(14px,env(safe-area-inset-bottom)) + 62px)!important}#gppu-shopping-panel{width:calc(100vw - 20px)!important}}
    @media(prefers-reduced-motion:reduce){#gppu-shopping-toggle{transition:none!important}}
  `;
  document.head?.append(style);
}

export function createShoppingListRunner({ retailerId, adapter }) {
  if (!retailerId || !adapter) throw new TypeError('Shopping-list runner requires a retailer adapter');
  let run = null;
  let busy = false;
  let root = null;
  let panel = null;
  let input = null;
  let mode = null;
  let status = null;
  let results = null;
  let actions = null;

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
      status.textContent = 'Paste a comma-separated list. Previewing does not change your cart.';
      actionButton('Preview cheapest choices', startPlanning);
      return;
    }
    input.value = run.items.map((item) => item.query).join(', ');
    mode.value = run.mode;
    input.disabled = true;
    mode.disabled = true;
    status.textContent = run.message || ({
      planning: `Planning item ${Math.min(run.currentIndex + 1, run.items.length)} of ${run.items.length}`,
      'ready-to-add': 'Preview complete. Review the choices before changing your cart.',
      adding: `Adding item ${Math.min(run.currentIndex + 1, run.items.length)} of ${run.items.length}`,
      reviewing: 'Reviewing the planned products in your cart',
      paused: 'Paused for your attention',
      complete: 'Cart run complete'
    }[run.phase]);
    for (const item of run.items) {
      const row = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = `${item.query} — ${item.status.replaceAll('-', ' ')}`;
      const detail = document.createElement('small');
      detail.textContent = describeItem(item);
      row.append(title, detail);
      results.append(row);
    }
    if (run.phase === 'ready-to-add') actionButton('Add planned items', startAdding);
    if (run.phase === 'paused') actionButton('I resolved it — continue', continueRun);
    if (run.phase === 'complete') actionButton('Start another list', resetRun);
    actionButton('Cancel run', cancelRun, true);
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
      mode: mode.value === 'total' ? 'total' : 'unit',
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
    run.message = 'Starting the explicitly approved Add phase';
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
    mode.disabled = false;
    input.value = '';
    render();
  }

  async function cancelRun() {
    await clearRun();
    input.disabled = false;
    mode.disabled = false;
    render();
  }

  async function advancePlanning() {
    const item = run.items[run.currentIndex];
    if (!item) {
      run.phase = 'ready-to-add';
      run.message = 'Preview complete. No cart changes have been made.';
      await saveRun();
      render();
      return;
    }
    const blocked = adapter.blockingReason?.();
    if (blocked) return pause(blocked, 'planning');
    if (!adapter.isSearchFor(item.query)) {
      item.status = 'pending';
      run.message = `Opening ${adapter.retailerName || 'the retailer'} search for “${item.query}”`;
      await saveRun();
      render();
      adapter.navigate(adapter.searchUrl(item.query));
      return;
    }
    item.status = 'collecting';
    run.message = `Loading all first-page results for “${item.query}”`;
    await saveRun();
    render();
    const collection = await adapter.collectProducts({
      onProgress: (message) => {
        run.message = boundedText(message, MAX_REASON_LENGTH);
        render();
      }
    });
    if (collection?.status === 'human-required') {
      item.status = 'pending';
      return pause(collection.reason, 'planning');
    }
    const chosen = chooseCheapestProduct(collection?.products ?? collection, run.mode);
    if (chosen) {
      item.status = 'planned';
      item.candidate = normalizedCandidate(chosen);
      item.selectedBy = chosen.selectedBy;
      item.reason = null;
    } else {
      item.status = 'missed';
      item.reason = 'No in-stock, verified product with an Add control was found in the loaded results.';
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
      run.message = 'Opening the cart for a final item-by-item review';
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
    if (!adapter.isSearchFor(item.query)) {
      item.status = 'planned';
      run.message = `Returning to “${item.query}” to add the exact previewed product`;
      await saveRun();
      render();
      adapter.navigate(adapter.searchUrl(item.query));
      return;
    }
    item.status = 'adding';
    run.message = `Adding ${item.candidate.name}`;
    await saveRun();
    render();
    const result = await adapter.addProduct(item.candidate, {
      onProgress: (message) => { run.message = boundedText(message, MAX_REASON_LENGTH); render(); }
    });
    if (result?.status === 'human-required') {
      item.status = 'planned';
      return pause(result.reason, 'adding');
    }
    if (result?.status === 'added') {
      item.status = 'added';
      item.priceChanged = result.priceChanged === true;
      item.reason = result.alreadyPresent === true
        ? 'This exact product was already represented in the cart, so it was not added twice.'
        : item.priceChanged ? 'Price changed after preview; the current product was added.' : null;
    } else {
      item.status = 'missed';
      item.reason = boundedText(result?.reason, MAX_REASON_LENGTH) || 'The Add action could not be verified.';
    }
    run.currentIndex += 1;
    run.message = null;
    await saveRun();
    render();
    return advanceAdding();
  }

  async function advanceReview() {
    if (!adapter.isCartPage()) {
      await saveRun();
      adapter.navigate(adapter.cartUrl());
      return;
    }
    const added = run.items.filter((item) => item.status === 'added' && item.candidate);
    const review = await adapter.reviewCart(added.map((item) => item.candidate));
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
      ? `Finished with ${missed} item${missed === 1 ? '' : 's'} requiring attention. Nothing was checked out.`
      : 'All planned Add actions completed. Nothing was checked out.';
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
    panel.hidden = true;
    const heading = document.createElement('h2');
    heading.textContent = 'Cheapest cart builder';
    const intro = document.createElement('p');
    intro.textContent = 'Preview a comma-separated list, then approve adding the exact choices.';
    const inputLabel = document.createElement('label');
    inputLabel.htmlFor = 'gppu-shopping-input';
    inputLabel.textContent = 'Shopping list';
    input = document.createElement('textarea');
    input.id = 'gppu-shopping-input';
    input.placeholder = 'Peanut butter, bananas, jelly, water';
    const modeLabel = document.createElement('label');
    modeLabel.htmlFor = 'gppu-shopping-mode';
    modeLabel.textContent = 'Cheapest means';
    mode = document.createElement('select');
    mode.id = 'gppu-shopping-mode';
    mode.append(new Option('Best comparable unit price', 'unit'), new Option('Lowest item price', 'total'));
    status = document.createElement('div');
    status.id = 'gppu-shopping-status';
    status.setAttribute('aria-live', 'polite');
    results = document.createElement('ul');
    results.id = 'gppu-shopping-results';
    actions = document.createElement('div');
    actions.className = 'gppu-shopping-actions';
    panel.append(heading, intro, inputLabel, input, modeLabel, mode, status, results, actions);
    const toggle = document.createElement('button');
    toggle.id = 'gppu-shopping-toggle';
    toggle.type = 'button';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<path d="M3 4h2l2.1 10.1a2 2 0 0 0 2 1.6h7.8a2 2 0 0 0 2-1.6L20 8H6.1M9.5 20a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm7 0a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"/>';
    toggle.append(icon);
    toggle.setAttribute('aria-label', 'Open cheapest cart builder');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      toggle.setAttribute('aria-expanded', String(!panel.hidden));
    });
    root.append(panel, toggle);
    document.body.append(root);
    run = await readRun();
    if (run) {
      panel.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
    }
    render();
    if (run && ACTIVE_PHASES.has(run.phase)) window.setTimeout(() => void advance(), 350);
  }

  return Object.freeze({
    install() {
      if (document.body) void mount();
      else document.addEventListener('DOMContentLoaded', () => void mount(), { once: true });
    }
  });
}
