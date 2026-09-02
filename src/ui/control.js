/*!
 * Shopper-visible control and annotation renderer.
 *
 * The menu selects a comparison basis; one adjacent arrow owns direction.
 * Status has two layers: concise visible copy and one complete polite live
 * announcement. Pending/no-match states explicitly preserve website order.
 * Obstruction avoidance reads geometry only and never operates the page layer.
 */

import { formatUnitPrice, speakUnitPrice } from './format.js';
import { areOnlyOwnedMutations } from '../runtime/mutations.js';

const LABELS = { mass: '$/kg', volume: '$/L', count: '$/each', total: 'total price' };
const DIRECTION_LABELS = { asc: 'Low → high', desc: 'High → low' };
const DIRECTION_NAMES = { asc: 'low to high', desc: 'high to low' };
const OPTIONS = [
  ['restore', 'Website order', null, null, 'Website order', 'Keep the retailer’s current order'],
  ['auto-asc', 'Automatic', 'auto', 'asc', 'Auto · Low → high', 'Predominant unit · Low to high'],
  ['auto-desc', 'Automatic', 'auto', 'desc', 'Auto · High → low', 'Predominant unit · High to low'],
  ['mass-asc', 'By weight', 'mass', 'asc', '$/kg · Low → high', 'Comparable price per kilogram · Low to high'],
  ['mass-desc', 'By weight', 'mass', 'desc', '$/kg · High → low', 'Comparable price per kilogram · High to low'],
  ['volume-asc', 'By volume', 'volume', 'asc', '$/L · Low → high', 'Comparable price per litre · Low to high'],
  ['volume-desc', 'By volume', 'volume', 'desc', '$/L · High → low', 'Comparable price per litre · High to low'],
  ['count-asc', 'By count', 'count', 'asc', '$/each · Low → high', 'Comparable price per item · Low to high'],
  ['count-desc', 'By count', 'count', 'desc', '$/each · High → low', 'Comparable price per item · High to low'],
  ['total-asc', 'Total price', 'total', 'asc', 'Total · Low → high', 'Current API price · Low to high'],
  ['total-desc', 'Total price', 'total', 'desc', 'Total · High → low', 'Current API price · High to low']
];
const MENU_OPTIONS = OPTIONS.filter(([, , , direction]) => direction !== 'desc');
const MENU_DETAILS = {
  restore: 'Keep the retailer’s current order',
  'auto-asc': 'Predominant comparable unit',
  'mass-asc': '$/kg',
  'volume-asc': '$/L',
  'count-asc': '$/each',
  'total-asc': 'Current price'
};
const MENU_GROUPS = new Map([
  ['restore', 'Website order'],
  ['auto-asc', 'Automatic'],
  ['mass-asc', 'Compare a unit'],
  ['total-asc', 'Total price']
]);
const OUTSIDE_CLICK = Symbol.for('grocery-price-per-unit.outside-click.v1');

function activeValue(state) {
  return state.restored ? 'restore' : `${state.dimension}-${state.direction}`;
}

function visibleValue(value) {
  return value === 'restore' ? value : value.replace(/-desc$/, '-asc');
}

function makeTick(template) {
  if (template) return template.cloneNode(true);
  const tick = document.createElement('span');
  tick.className = 'lups-menu-tick';
  tick.setAttribute('aria-hidden', 'true');
  tick.textContent = '✓';
  return tick;
}

function installObstructionAvoidance(root) {
  let currentLift = 0;
  let blocker = null;
  let placementApplied = false;
  let measureTimer = null;
  let liftedPoll = null;
  let lifecyclePoll = null;
  let lastMeasurement = 0;
  let disposed = false;
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule()) : null;

  const ownedMutation = (record) => record.target.closest?.('#lups-control,[data-lups-annotation]');
  const candidateFor = (element, point, baselineRect) => {
    for (let candidate = element; candidate && candidate !== document.documentElement; candidate = candidate.parentElement) {
      if (root.contains(candidate)) return null;
      const style = getComputedStyle(candidate);
      if (style.position !== 'fixed' && style.position !== 'sticky') continue;
      const rect = candidate.getBoundingClientRect();
      const bottomTouching = rect.bottom >= window.innerHeight - 3;
      const broad = rect.width >= window.innerWidth * 0.6
        && rect.left <= window.innerWidth * 0.2 && rect.right >= window.innerWidth * 0.8;
      const containsPoint = point.x >= rect.left && point.x <= rect.right
        && point.y >= rect.top && point.y <= rect.bottom;
      const leavesClearSpace = rect.top >= baselineRect.height + 24;
      const notFullscreen = rect.height <= window.innerHeight * 0.45;
      if (bottomTouching && broad && containsPoint && leavesClearSpace && notFullscreen) return { element: candidate, rect };
    }
    return null;
  };

  function observeBlocker(nextBlocker) {
    if (blocker === nextBlocker) return;
    if (blocker) resizeObserver?.unobserve(blocker);
    blocker = nextBlocker;
    if (blocker) resizeObserver?.observe(blocker);
  }

  function applyLift(nextLift, nextBlocker = null) {
    if (placementApplied && nextLift === currentLift && nextBlocker === blocker) return;
    placementApplied = true;
    currentLift = nextLift;
    root.style.setProperty('--lups-obstruction-lift', `${nextLift}px`);
    root.dataset.lupsObstructed = String(nextLift > 0);
    observeBlocker(nextBlocker);
    if (nextLift > 0 && !liftedPoll) liftedPoll = setInterval(schedule, 1000);
    if (nextLift === 0 && liftedPoll) {
      clearInterval(liftedPoll);
      liftedPoll = null;
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(measureTimer);
    clearInterval(liftedPoll);
    clearInterval(lifecyclePoll);
    mutationObserver.disconnect();
    resizeObserver?.disconnect();
    window.removeEventListener('resize', schedule);
    window.removeEventListener('scroll', schedule, true);
    window.removeEventListener('orientationchange', schedule);
    window.removeEventListener('pageshow', schedule);
    window.visualViewport?.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('scroll', schedule);
  }

  function measure() {
    measureTimer = null;
    if (!root.isConnected) { dispose(); return; }
    lastMeasurement = performance.now();
    const rect = root.getBoundingClientRect();
    const baselineRect = {
      left: rect.left,
      right: rect.right,
      top: rect.top + currentLift,
      bottom: rect.bottom + currentLift,
      width: rect.width,
      height: rect.height
    };
    const y = Math.min(window.innerHeight - 2, baselineRect.bottom - 6);
    const probes = [0.25, 0.5, 0.75].map((ratio) => ({
      x: baselineRect.left + baselineRect.width * ratio,
      y
    }));
    const candidates = probes.map((point) => {
      for (const element of document.elementsFromPoint(point.x, point.y)) {
        const candidate = candidateFor(element, point, baselineRect);
        if (candidate) return candidate;
      }
      return null;
    }).filter(Boolean);
    const counts = new Map();
    for (const candidate of candidates) counts.set(candidate.element, (counts.get(candidate.element) || 0) + 1);
    const obstruction = candidates.find((candidate) => counts.get(candidate.element) >= 2) || null;
    const lift = obstruction ? Math.ceil(baselineRect.bottom - obstruction.rect.top + 12) : 0;
    const fits = lift > 0 && baselineRect.top - lift >= 12;
    applyLift(fits ? lift : 0, fits ? obstruction.element : null);
  }

  function schedule() {
    if (disposed) return;
    if (!root.isConnected) { dispose(); return; }
    if (measureTimer !== null) return;
    const elapsed = performance.now() - lastMeasurement;
    measureTimer = setTimeout(measure, Math.max(0, 120 - elapsed));
  }

  const mutationObserver = new MutationObserver((records) => {
    if (!areOnlyOwnedMutations(records, ownedMutation)) schedule();
  });
  mutationObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['class', 'hidden', 'style'],
    childList: true,
    subtree: true
  });
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('scroll', schedule, { passive: true, capture: true });
  window.addEventListener('orientationchange', schedule, { passive: true });
  window.addEventListener('pageshow', schedule, { passive: true });
  window.visualViewport?.addEventListener('resize', schedule, { passive: true });
  window.visualViewport?.addEventListener('scroll', schedule, { passive: true });
  root.addEventListener('gppu:layout-change', schedule);
  lifecyclePoll = setInterval(() => { if (!root.isConnected) dispose(); }, 2000);
  requestAnimationFrame(schedule);
}

function createNativeControl(nativeSection, onChange, state, adapter = {}) {
  const root = document.createElement('section');
  root.id = 'lups-control';
  root.dataset.lupsFloating = 'true';
  root.setAttribute('aria-label', 'Unit price sorting');

  const nativeInner = nativeSection.firstElementChild;
  const inner = document.createElement('div');
  inner.className = nativeInner?.className || '';
  inner.style.position = 'relative';

  const nativeLabel = adapter.nativeLabel || nativeSection.querySelector('[data-testid="sort-label"]');
  const label = nativeLabel?.cloneNode(true) || document.createElement('label');
  label.id = 'lups-label';
  label.removeAttribute('data-testid');
  label.querySelector('p') ? label.querySelector('p').textContent = 'Unit price' : label.textContent = 'Unit price';

  const nativeButton = adapter.nativeButton || nativeSection.querySelector('[data-testid="menu-button"]');
  const button = nativeButton.cloneNode(true);
  button.id = 'lups-menu-button';
  button.removeAttribute('data-testid');
  button.setAttribute('aria-controls', 'lups-menu');
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-labelledby', 'lups-label lups-menu-button-text');
  button.setAttribute('aria-expanded', 'false');
  button.textContent = '';
  const buttonCopy = document.createElement('span');
  buttonCopy.className = 'lups-button-copy';
  const buttonKicker = document.createElement('span');
  buttonKicker.className = 'lups-button-kicker';
  buttonKicker.textContent = 'Unit price';
  const buttonText = document.createElement('span');
  buttonText.id = 'lups-menu-button-text';
  const chevron = document.createElement('span');
  chevron.className = 'lups-menu-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  buttonCopy.append(buttonKicker, buttonText);
  button.append(buttonCopy, chevron);

  const triggerRow = document.createElement('div');
  triggerRow.className = 'lups-trigger-row';
  const autoButton = document.createElement('button');
  autoButton.id = 'lups-auto-sort';
  autoButton.type = 'button';
  autoButton.textContent = 'Auto';
  autoButton.setAttribute('aria-label', 'Sort automatically, low to high');
  const flipButton = document.createElement('button');
  flipButton.id = 'lups-flip-direction';
  flipButton.type = 'button';
  flipButton.hidden = true;
  triggerRow.append(autoButton, flipButton, button);

  const nativeMenuList = adapter.nativeMenuList || nativeSection.querySelector('[data-testid="menu-list"]');
  const nativeMenuHost = nativeMenuList?.parentElement;
  const menuHost = document.createElement('div');
  menuHost.className = nativeMenuHost?.className || '';
  menuHost.id = 'lups-menu-host';
  menuHost.hidden = true;
  menuHost.style.cssText = 'position:absolute;z-index:2147483647;min-width:max-content;top:100%;right:0;';
  const menu = document.createElement('div');
  menu.id = 'lups-menu';
  menu.className = nativeMenuList?.className || '';
  menu.tabIndex = -1;
  menu.style.cssText = 'opacity:1;visibility:visible;transform:none;max-height:min(70vh,560px);overflow-y:auto;';
  const menuOptions = document.createElement('div');
  menuOptions.id = 'lups-menu-options';
  menuOptions.setAttribute('aria-label', 'Unit price sort');
  menuOptions.setAttribute('role', 'menu');
  menuOptions.setAttribute('aria-orientation', 'vertical');
  const guide = document.createElement('details');
  guide.className = 'lups-guide';
  const guideSummary = document.createElement('summary');
  guideSummary.textContent = 'How comparison works';
  guideSummary.setAttribute('aria-expanded', 'false');
  const guideCopy = document.createElement('p');
  guideCopy.textContent = 'Automatic uses the most common comparable unit among loaded products. Use the arrow beside the selector to reverse the current sort. We never compare $/kg, $/L, and $/each. Retailer means the store supplied the unit price; Calculated uses its current price and package quantity.';
  guide.append(guideSummary, guideCopy);
  menu.append(menuOptions, guide);
  const menuCue = document.createElement('div');
  menuCue.className = 'lups-menu-overflow-cue';
  menuCue.hidden = true;
  menuCue.setAttribute('aria-hidden', 'true');
  menuCue.textContent = 'More sorting options below ↓';

  const nativeItem = nativeMenuList?.querySelector('[data-testid="menu-item"]');
  const nativeTick = nativeMenuList?.querySelector('[data-testid="menu-tick-icon"]');
  const select = document.createElement('select');
  select.id = 'lups-mode';
  select.setAttribute('aria-hidden', 'true');
  select.tabIndex = -1;
  select.hidden = true;

  const items = () => [...menuOptions.querySelectorAll('[data-lups-value]')];
  function updateMenuCue() {
    const overflow = menu.scrollHeight - menu.clientHeight > 1;
    menuHost.dataset.lupsOverflow = String(overflow);
    menuCue.hidden = !overflow || menu.scrollTop + menu.clientHeight >= menu.scrollHeight - 1;
  }
  function closeMenu({ focusButton = false } = {}) {
    menuHost.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    for (const item of items()) item.tabIndex = -1;
    guide.open = false;
    guideSummary.setAttribute('aria-expanded', 'false');
    if (focusButton) button.focus();
  }
  function focusItem(item) {
    if (!item) return;
    for (const candidate of items()) candidate.tabIndex = candidate === item ? 0 : -1;
    item.focus();
    requestAnimationFrame(updateMenuCue);
  }
  function openMenu() {
    menuHost.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    focusItem(menuOptions.querySelector(`[data-lups-value="${visibleValue(select.value)}"]`) || items()[0]);
    updateMenuCue();
  }
  function choose(value, { focusButton = false, emit = false } = {}) {
    const option = OPTIONS.find(([key]) => key === value) || OPTIONS[0];
    select.value = option[0];
    buttonText.textContent = option[4];
    root.dataset.lupsMode = option[0];
    root.dataset.lupsRequestedDimension = option[2] || '';
    root.dataset.lupsDirection = option[3] || '';
    autoButton.hidden = option[0] !== 'restore';
    flipButton.hidden = option[0] === 'restore';
    if (option[0] !== 'restore') {
      const nextDirection = option[3] === 'asc' ? 'desc' : 'asc';
      flipButton.textContent = option[3] === 'asc' ? '↓' : '↑';
      flipButton.title = DIRECTION_LABELS[nextDirection];
      flipButton.setAttribute('aria-label', `Reverse unit-price order to ${DIRECTION_NAMES[nextDirection]}`);
    }
    for (const item of menuOptions.querySelectorAll('[data-lups-value]')) {
      const chosen = item.dataset.lupsValue === visibleValue(option[0]);
      item.setAttribute('aria-checked', String(chosen));
      item.querySelector('[data-lups-tick]')?.toggleAttribute('hidden', !chosen);
    }
    closeMenu({ focusButton });
    if (option[0] === 'restore') onChange({ type: 'restore' });
    else onChange({ type: 'sort', dimension: option[2], direction: option[3] });
    if (emit) root.dispatchEvent(new CustomEvent('gppu:mode-change', {
      bubbles: true,
      detail: { value: option[0] }
    }));
  }

  function chooseMenuOption(value) {
    if (value === 'restore') {
      choose(value, { focusButton: true, emit: true });
      return;
    }
    const dimension = value.replace(/-asc$/, '');
    const currentDirection = /-(asc|desc)$/.exec(select.value)?.[1] || 'asc';
    choose(`${dimension}-${currentDirection}`, { focusButton: true, emit: true });
  }

  for (const [value, title, , , , detail] of OPTIONS) {
    select.add(new Option(`${title}: ${detail}`, value));
  }
  let groupItems = null;
  for (const [value, title] of MENU_OPTIONS) {
    const groupName = MENU_GROUPS.get(value);
    if (groupName) {
      const group = document.createElement('div');
      group.className = 'lups-menu-section';
      group.setAttribute('role', 'presentation');
      const heading = document.createElement('div');
      heading.className = 'lups-menu-group';
      heading.setAttribute('role', 'presentation');
      heading.setAttribute('aria-hidden', 'true');
      heading.textContent = groupName;
      groupItems = document.createElement('div');
      groupItems.className = 'lups-menu-group-items';
      groupItems.setAttribute('role', 'presentation');
      group.append(heading, groupItems);
      menuOptions.append(group);
    }
    const detail = MENU_DETAILS[value];
    const item = nativeItem?.cloneNode(true) || document.createElement('button');
    item.type = 'button';
    item.id = `lups-menu-item-${value}`;
    item.removeAttribute('data-testid');
    item.dataset.lupsValue = value;
    item.setAttribute('role', 'menuitemradio');
    item.tabIndex = -1;
    item.textContent = '';
    item.setAttribute('aria-label', `${title}, ${detail}`);
    const copy = document.createElement('span');
    copy.className = 'lups-option-copy';
    const itemTitle = document.createElement('strong');
    itemTitle.className = 'lups-option-title';
    itemTitle.textContent = title;
    const itemDetail = document.createElement('small');
    itemDetail.className = 'lups-option-detail';
    itemDetail.textContent = detail;
    copy.append(itemTitle, itemDetail);
    const tick = makeTick(nativeTick);
    tick.removeAttribute('data-testid');
    tick.dataset.lupsTick = '';
    item.append(copy, tick);
    item.addEventListener('click', () => chooseMenuOption(value));
    groupItems.append(item);
  }
  select.value = activeValue(state);
  select.addEventListener('change', () => choose(select.value, { focusButton: true, emit: true }));
  flipButton.addEventListener('click', () => {
    const match = /^(auto|mass|volume|count|total)-(asc|desc)$/.exec(select.value);
    if (!match) return;
    const partner = `${match[1]}-${match[2] === 'asc' ? 'desc' : 'asc'}`;
    choose(partner, { focusButton: true, emit: true });
  });
  autoButton.addEventListener('click', () => choose('auto-asc', { focusButton: true, emit: true }));

  button.addEventListener('click', () => {
    if (menuHost.hidden) openMenu();
    else closeMenu({ focusButton: true });
  });
  guide.addEventListener('toggle', () => {
    guideSummary.setAttribute('aria-expanded', String(guide.open));
    requestAnimationFrame(() => {
      updateMenuCue();
      // Establish any cue-reserved padding before scrolling. Otherwise the
      // padding itself extends the scroll range after we thought we reached
      // the end, leaving the expanded guide obscured at compact widths.
      if (!menuHost.hidden && guide.open) menu.scrollTop = menu.scrollHeight;
      updateMenuCue();
    });
  });
  menu.addEventListener('keydown', (event) => {
    const menuItems = items();
    const index = menuItems.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); closeMenu({ focusButton: true }); }
    else if (event.key === 'Tab' && document.activeElement !== guideSummary && !event.shiftKey) {
      event.preventDefault();
      guideSummary.focus();
    } else if (event.key === 'Tab' && document.activeElement === guideSummary && event.shiftKey) {
      event.preventDefault();
      focusItem(menuOptions.querySelector(`[data-lups-value="${visibleValue(select.value)}"]`) || menuItems[0]);
    } else if (event.key === 'Tab') closeMenu();
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (document.activeElement === guideSummary) {
        focusItem(event.key === 'ArrowUp' ? menuItems.at(-1) : menuItems[0]);
        return;
      }
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      focusItem(menuItems[(index + delta + menuItems.length) % menuItems.length]);
    } else if (event.key === 'Home') { event.preventDefault(); focusItem(menuItems[0]); }
    else if (event.key === 'End') { event.preventDefault(); focusItem(menuItems.at(-1)); }
  });
  menu.addEventListener('scroll', updateMenuCue, { passive: true });
  if (typeof ResizeObserver === 'function') new ResizeObserver(updateMenuCue).observe(menu);
  root.addEventListener('gppu:close-menu', () => closeMenu());
  if (!document[OUTSIDE_CLICK]) {
    const listener = (event) => {
      const current = document.getElementById('lups-control');
      if (current && !current.contains(event.target)) current.dispatchEvent(new CustomEvent('gppu:close-menu'));
    };
    document.addEventListener('click', listener);
    Object.defineProperty(document, OUTSIDE_CLICK, { value: listener });
  }

  const statusRow = document.createElement('div');
  statusRow.id = 'lups-status-row';
  statusRow.hidden = true;
  const status = document.createElement('span');
  status.id = 'lups-status';
  const liveStatus = document.createElement('output');
  liveStatus.id = 'lups-live-status';
  liveStatus.className = 'lups-visually-hidden';
  liveStatus.setAttribute('aria-live', 'polite');
  liveStatus.setAttribute('aria-atomic', 'true');
  const restoreButton = document.createElement('button');
  restoreButton.id = 'lups-restore';
  restoreButton.type = 'button';
  restoreButton.textContent = 'Restore';
  restoreButton.setAttribute('aria-label', 'Restore website order');
  restoreButton.hidden = true;
  restoreButton.addEventListener('click', () => choose('restore', { focusButton: true, emit: true }));
  const reloadButton = document.createElement('button');
  reloadButton.id = 'lups-reload';
  reloadButton.type = 'button';
  reloadButton.textContent = 'Reload page';
  reloadButton.setAttribute('aria-label', 'Reload page to capture current product data');
  reloadButton.hidden = true;
  reloadButton.addEventListener('click', () => onChange({ type: 'reload' }));
  statusRow.append(status, restoreButton, reloadButton);
  menuHost.append(menu, menuCue);
  inner.append(label, triggerRow, menuHost, select, statusRow, liveStatus);
  root.append(inner);
  (adapter.insert || ((control) => nativeSection.insertAdjacentElement('afterend', control)))(root);
  installObstructionAvoidance(root);
  choose(activeValue(state));
  return root;
}

export function createControl(onChange, state = { dimension: 'auto', direction: 'asc', restored: true }, adapter = {}) {
  const template = document.createElement('section');
  const button = document.createElement('button');
  button.type = 'button';
  const buttonText = document.createElement('span');
  button.append(buttonText);
  template.append(button);
  return createNativeControl(template, onChange, state, {
    ...adapter,
    nativeButton: button,
    insert: (control) => document.body.append(control)
  });
}

export function updateStatus(root, { dimension, sortable, incompatible, unknown, total, excluded = 0, range = null, restored = false, dataState = null }) {
  // Retailer SPAs can replace <head> after the control has been created. Repair
  // the shared stylesheet during every render so an existing panel never
  // degrades into unstyled document flow after a search or store transition.
  injectStyles();
  const requestedDimension = root.dataset.lupsRequestedDimension;
  const direction = root.dataset.lupsDirection;
  const directionLabel = DIRECTION_LABELS[direction];
  if (!restored && !dataState && requestedDimension === 'auto') {
    root.querySelector('#lups-menu-button-text').textContent = `Auto · ${LABELS[dimension]} · ${directionLabel}`;
  }
  const loadedProducts = Number.isFinite(total) ? `${total} loaded ${total === 1 ? 'product' : 'products'}` : null;
  const preservation = 'Website order preserved';
  const promotions = `${excluded} sponsored/ad ${excluded === 1 ? 'tile' : 'tiles'} hidden`;
  const transitional = dataState === 'reload-needed'
    ? ['Current product data was loaded before the userscript', 'Reload once', preservation, ...(loadedProducts ? [loadedProducts] : []), ...(excluded ? [promotions] : [])]
    : dataState === 'pending'
      ? ['Waiting for current-page product data', preservation, ...(loadedProducts ? [loadedProducts] : []), ...(excluded ? [promotions] : [])]
    : dataState === 'no-match'
      ? ['No matching product data in these loaded results', preservation, ...(loadedProducts ? [loadedProducts] : []), ...(excluded ? [promotions] : [])]
      : null;
  const summaryParts = restored ? [] : [
    dimension === 'total' ? `${sortable} priced` : `${sortable} comparable`,
    ...(range ? [`Loaded range $${range.minimum.toFixed(2)}–$${range.maximum.toFixed(2)}${dimension === 'total' ? '' : LABELS[dimension].slice(1)}`] : []),
    ...(incompatible ? [`${incompatible} different-unit ${incompatible === 1 ? 'product follows' : 'products follow'}`] : []),
    ...(unknown ? [`${unknown} unavailable`] : []),
    loadedProducts,
    ...(dimension === 'total' && requestedDimension === 'auto' ? ['no comparable unit prices available'] : [])
  ];
  if (excluded) summaryParts.push(promotions);
  const visibleParts = transitional || (restored ? ['Website order', ...summaryParts] : summaryParts);
  const announcementParts = transitional || (restored ? [
    'Website order',
    ...(loadedProducts ? [loadedProducts] : []),
    ...(excluded ? [promotions] : [])
  ] : [
    requestedDimension === 'auto' ? `Automatic chose ${LABELS[dimension]}` : `Sorted by ${LABELS[dimension]}`,
    directionLabel,
    ...summaryParts
  ]);
  const status = root.querySelector('#lups-status');
  const visibleStatus = visibleParts.join(' · ');
  if (status.textContent !== visibleStatus) status.textContent = visibleStatus;
  const liveStatus = root.querySelector('#lups-live-status');
  const announcementStatus = announcementParts.join(' · ');
  if (liveStatus.textContent !== announcementStatus) liveStatus.textContent = announcementStatus;
  root.querySelector('#lups-status-row').hidden = restored && !excluded;
  root.querySelector('#lups-restore').hidden = restored || dataState === 'reload-needed';
  root.querySelector('#lups-reload').hidden = dataState !== 'reload-needed';
  root.dataset.lupsRestored = String(restored);
  root.dataset.lupsDataState = dataState || 'ready';
  root.dispatchEvent(new Event('gppu:layout-change'));
}

export function annotate(model) {
  const host = model.annotationHost || model.productCard || model.card;
  let note = host.querySelector('[data-lups-annotation]');
  if (!note) {
    note = document.createElement('div');
    note.setAttribute('data-lups-annotation', '');
    note.className = 'lups-annotation';
    host.append(note);
  }
  if (Number.isFinite(model.normalizedUnitPrice)) {
    const explicit = model.source === 'explicit-site-unit-price';
    const origin = explicit ? 'Retailer' : 'Calculated';
    note.dataset.source = explicit ? 'retailer' : 'calculated';
    note.textContent = `${formatUnitPrice(model.normalizedUnitPrice, model.normalizedUnit)} · ${origin}`;
    note.title = explicit ? 'Unit price supplied by the retailer API' : 'Calculated from retailer API package and price data';
    const description = `${note.title[0].toLowerCase()}${note.title.slice(1)}`;
    note.setAttribute('aria-label', `${speakUnitPrice(model.normalizedUnitPrice, model.normalizedUnit)}, ${description}`);
  } else {
    note.dataset.source = 'unknown';
    note.textContent = model.source === 'ambiguous' ? 'Unit price ambiguous' : 'Unit price unavailable';
    note.removeAttribute('title');
    note.removeAttribute('aria-label');
  }
}

let adoptedStyleSheet = null;

export function injectStyles() {
  let style = document.getElementById('lups-styles');
  if (!style) {
    style = document.createElement('style');
    style.id = 'lups-styles';
    style.textContent = `
    #lups-control[data-lups-floating="true"]{position:fixed!important;z-index:2147483646!important;right:max(18px,env(safe-area-inset-right))!important;bottom:calc(max(18px,env(safe-area-inset-bottom)) + var(--lups-obstruction-lift,0px))!important;margin:0!important;color:#17221d;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;transition:bottom .16s ease-out!important}
    #lups-control[data-lups-floating="true"]>div{position:relative!important;display:flex!important;align-items:flex-end!important;flex-direction:column!important;gap:7px!important}
    #lups-label{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
    .lups-visually-hidden{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
    .lups-trigger-row{display:flex!important;align-items:stretch!important;justify-content:flex-end!important;gap:7px!important}
    #lups-menu-button{box-sizing:border-box!important;display:inline-flex!important;align-items:center!important;justify-content:space-between!important;gap:12px!important;min-width:220px!important;min-height:46px!important;padding:8px 12px!important;border:1px solid #9eb9a9!important;border-radius:12px!important;background:linear-gradient(180deg,#f8fcf9 0%,#edf7f0 100%)!important;color:#155f45!important;box-shadow:0 2px 7px #163f2b1a!important;font:600 14px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;white-space:nowrap!important;transition:border-color .15s ease,box-shadow .15s ease,background .15s ease!important}
    #lups-menu-button:hover{border-color:#438a6d!important;background:#e8f5ec!important;box-shadow:0 2px 5px #163f2b1f!important}
    #lups-menu-button[aria-expanded="true"]{border-color:#197454!important;background:#e4f3e9!important;box-shadow:0 0 0 3px #1b805326!important}
    #lups-auto-sort,#lups-flip-direction{box-sizing:border-box!important;min-height:46px!important;padding:0 12px!important;border:1px solid #9eb9a9!important;border-radius:12px!important;background:linear-gradient(180deg,#f8fcf9 0%,#edf7f0 100%)!important;color:#155f45!important;box-shadow:0 2px 7px #163f2b1a!important;font:700 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;transition:border-color .15s ease,box-shadow .15s ease,background .15s ease!important}
    #lups-flip-direction{width:46px!important;min-width:46px!important;padding:0!important;font-size:22px!important;font-weight:750!important}
    #lups-auto-sort:hover,#lups-flip-direction:hover{border-color:#438a6d!important;background:#e8f5ec!important;box-shadow:0 2px 5px #163f2b1f!important}
    #lups-auto-sort[hidden],#lups-flip-direction[hidden]{display:none!important}
    .lups-button-copy{display:flex!important;min-width:0!important;flex:1!important;align-items:flex-start!important;flex-direction:column!important;gap:1px!important;text-align:left!important}
    .lups-button-kicker{color:#537065!important;font-size:9.5px!important;font-weight:750!important;letter-spacing:.08em!important;line-height:1.1!important;text-transform:uppercase!important}
    #lups-menu-button-text{max-width:190px!important;overflow:hidden!important;text-overflow:ellipsis!important}
    .lups-menu-chevron{box-sizing:border-box!important;width:8px!important;height:8px!important;flex:0 0 auto!important;margin:0 3px 4px 0!important;border-right:2px solid #39735e!important;border-bottom:2px solid #39735e!important;transform:rotate(45deg)!important;transition:transform .15s ease,margin .15s ease!important}
    #lups-menu-button[aria-expanded="true"] .lups-menu-chevron{margin:4px 3px 0 0!important;transform:rotate(225deg)!important}
    #lups-status-row{box-sizing:border-box!important;display:flex!important;max-width:min(360px,calc(100vw - 24px))!important;align-items:center!important;gap:8px!important;padding:7px 8px 7px 10px!important;border:1px solid #d6e3db!important;border-radius:12px!important;background:#fffffff5!important;box-shadow:0 3px 12px #163f2b1a!important;color:#30473d!important}
    #lups-status-row[hidden],#lups-restore[hidden],#lups-reload[hidden]{display:none!important}
    #lups-status{min-width:0!important;flex:1!important;font:550 11.5px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;text-align:left!important}
    #lups-restore,#lups-reload{box-sizing:border-box!important;min-height:44px!important;padding:7px 10px!important;border:1px solid #9eb9a9!important;border-radius:9px!important;background:#edf7f0!important;color:#155f45!important;font:700 11.5px/1.1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;white-space:nowrap!important}
    #lups-restore:hover,#lups-reload:hover{border-color:#438a6d!important;background:#e4f3e9!important}
    #lups-control[data-lups-floating="true"] [data-lups-tick][hidden]{display:none!important}
    #lups-menu-host[hidden]{display:none!important}
    #lups-menu-host{box-sizing:border-box!important;top:auto!important;right:0!important;bottom:calc(100% + 8px)!important;width:min(350px,calc(100vw - 24px))!important;min-width:0!important}
    #lups-menu{box-sizing:border-box!important;width:100%!important;max-height:min(70vh,calc(100dvh - var(--lups-obstruction-lift,0px) - 140px),560px)!important;padding:8px!important;border:1px solid #d8e2dc!important;border-radius:14px!important;background:#fff!important;color:#17221d!important;box-shadow:0 18px 48px #14251d2e,0 3px 10px #14251d1f!important}
    #lups-menu-host[data-lups-overflow="true"] #lups-menu{padding-bottom:38px!important}
    .lups-menu-overflow-cue{position:absolute!important;right:1px!important;bottom:1px!important;left:1px!important;display:flex!important;height:38px!important;box-sizing:border-box!important;align-items:flex-end!important;justify-content:center!important;padding:13px 8px 6px!important;border-radius:0 0 13px 13px!important;background:linear-gradient(180deg,#ffffff00 0%,#fff 48%)!important;color:#39735e!important;font:700 10.5px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;letter-spacing:.02em!important;pointer-events:none!important}
    .lups-menu-overflow-cue[hidden]{display:none!important}
    .lups-menu-section{display:block!important}
    .lups-menu-group{padding:9px 8px 4px!important;color:#607068!important;font-size:10px!important;font-weight:750!important;letter-spacing:.08em!important;line-height:1!important;text-transform:uppercase!important}
    .lups-menu-group:first-child{padding-top:5px!important}
    .lups-menu-group-items{display:grid!important;grid-template-columns:1fr!important;gap:4px!important}
    .lups-guide{margin:7px 2px 1px!important;padding:5px 8px 0!important;border-top:1px solid #e1e8e3!important;color:#30473d!important}
    .lups-guide summary{box-sizing:border-box!important;display:flex!important;min-height:44px!important;align-items:center!important;justify-content:space-between!important;gap:12px!important;cursor:pointer!important;list-style:none!important;color:#24684f!important;font:700 12px/1.25 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important}
    .lups-guide summary::-webkit-details-marker{display:none!important}
    .lups-guide summary::after{content:'+'!important;display:grid!important;width:24px!important;height:24px!important;flex:0 0 auto!important;place-items:center!important;border-radius:999px!important;background:#edf7f0!important;color:#197454!important;font-size:17px!important;line-height:1!important}
    .lups-guide[open] summary::after{content:'−'!important}
    .lups-guide p{margin:0 0 10px!important;padding:1px 2px 2px!important;color:#50645a!important;font:500 11.5px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important}
    #lups-menu [data-lups-value]{box-sizing:border-box!important;display:flex!important;align-items:center!important;justify-content:space-between!important;gap:7px!important;width:100%!important;min-width:0!important;min-height:46px!important;padding:6px 8px!important;border:0!important;border-radius:9px!important;background:transparent!important;color:inherit!important;text-align:left!important;font-family:inherit!important}
    #lups-menu [data-lups-value]:hover,#lups-menu [data-lups-value]:focus-visible{background:#f0f7f2!important}
    #lups-menu [data-lups-value][aria-checked="true"]{background:#e4f3e9!important;color:#0e6245!important}
    .lups-option-copy{display:flex;min-width:0;flex:1;flex-direction:column;gap:2px}
    .lups-option-title{overflow:hidden;font-size:13px;line-height:1.2;font-weight:650;text-overflow:ellipsis;white-space:nowrap}
    .lups-option-detail{overflow:hidden;color:#607068;font-size:11.5px;line-height:1.25;font-weight:450;text-overflow:ellipsis;white-space:nowrap}
    #lups-menu [aria-checked="true"] .lups-option-detail{color:#39735e}
    #lups-menu [data-lups-tick]{flex:0 0 auto;color:#197454}
    #lups-control :focus-visible{outline:3px solid #1769aa;outline-offset:2px}
    .lups-annotation{box-sizing:border-box!important;display:block!important;width:max-content!important;max-width:100%!important;margin:6px 0!important;padding:4px 8px!important;border:1px solid #9bc9ae!important;border-radius:999px!important;background:#edf8ef!important;color:#184d27!important;font:650 12px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important}
    .lups-annotation[data-source="calculated"]{border-color:#1769aa!important;background:#eef6fc!important;color:#164b72!important}.lups-annotation[data-source="unknown"]{border-color:#777!important;background:#f4f4f4!important;color:#555!important}
    @media(max-width:640px){#lups-control[data-lups-floating="true"]{right:max(10px,env(safe-area-inset-right))!important;bottom:calc(max(14px,env(safe-area-inset-bottom)) + var(--lups-obstruction-lift,0px))!important}#lups-menu-button{min-width:0!important;width:196px!important;min-height:44px!important;padding:7px 10px!important;font-size:13px!important}#lups-auto-sort,#lups-flip-direction{min-height:44px!important}#lups-flip-direction{width:44px!important;min-width:44px!important}#lups-menu-button-text{max-width:160px!important}#lups-status-row{max-width:calc(100vw - 20px)!important}#lups-menu-host{position:absolute!important;right:0!important;bottom:calc(100% + 8px)!important;width:calc(100vw - 20px - env(safe-area-inset-left) - env(safe-area-inset-right))!important}#lups-menu{max-height:min(64dvh,calc(100dvh - var(--lups-obstruction-lift,0px) - 150px),520px)!important}}
    @media(forced-colors:active){
      #lups-control[data-lups-floating="true"]{color:CanvasText!important}
      #lups-menu-button,#lups-auto-sort,#lups-flip-direction,#lups-restore,#lups-reload,#lups-status-row,#lups-menu,.lups-guide summary::after{border-color:CanvasText!important;background:Canvas!important;color:CanvasText!important;box-shadow:none!important}
      #lups-menu [data-lups-value]{border:2px solid transparent!important;background:Canvas!important;color:CanvasText!important}
      #lups-menu [data-lups-value][aria-checked="true"]{border-color:Highlight!important;background:Highlight!important;color:HighlightText!important}
      #lups-menu [data-lups-value][aria-checked="true"] .lups-option-detail,#lups-menu [data-lups-value][aria-checked="true"] [data-lups-tick]{color:HighlightText!important}
      .lups-button-kicker,.lups-option-detail,.lups-menu-group,.lups-guide,.lups-guide p,.lups-guide summary{color:CanvasText!important}
      .lups-menu-overflow-cue{background:Canvas!important;color:CanvasText!important}
      .lups-annotation,.lups-annotation[data-source="calculated"],.lups-annotation[data-source="unknown"]{border-color:CanvasText!important;background:Canvas!important;color:CanvasText!important}
      .lups-annotation{border-width:2px!important;border-style:solid!important}
      .lups-annotation[data-source="calculated"]{border-style:dashed!important}
      .lups-annotation[data-source="unknown"]{border-style:dotted!important}
      #lups-control :focus-visible{outline:3px solid Highlight!important}
    }
    @media(prefers-contrast:more){
      #lups-menu-button,#lups-auto-sort,#lups-flip-direction,#lups-restore,#lups-reload,#lups-status-row,#lups-menu{border-width:2px!important;box-shadow:none!important}
      #lups-menu [data-lups-value][aria-checked="true"]{outline:2px solid currentColor!important;outline-offset:-2px!important}
      .lups-annotation{border-width:2px!important}
      .lups-annotation[data-source="calculated"]{border-style:dashed!important}
      .lups-annotation[data-source="unknown"]{border-style:dotted!important}
      #lups-status{font-weight:650!important}
    }
    @media(prefers-reduced-motion:reduce){#lups-control[data-lups-floating="true"],#lups-menu-button,#lups-auto-sort,#lups-flip-direction,.lups-menu-chevron{transition:none!important}}
    `;
    document.head.append(style);
  }

  // Retailer SPAs may replace <head> and remove the fallback <style>. Safari can
  // also apply a site's Content Security Policy to styles added by a userscript.
  // A constructed stylesheet is document-owned, so it survives head replacement
  // and works under a strict style-src policy. Keep the element for older engines.
  if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in document) {
    try {
      if (!adoptedStyleSheet) {
        adoptedStyleSheet = new CSSStyleSheet();
        adoptedStyleSheet.replaceSync(style.textContent);
      }
      if (!document.adoptedStyleSheets.includes(adoptedStyleSheet)) {
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, adoptedStyleSheet];
      }
    } catch {
      adoptedStyleSheet = null;
    }
  }
}
