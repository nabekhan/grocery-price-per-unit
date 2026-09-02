/*!
 * Shopper-visible control and annotation renderer.
 *
 * The compact floating action menu selects a comparison basis; one adjacent
 * arrow owns direction. Routine status is available as a hover/focus tooltip,
 * while the missed-capture recovery remains visibly actionable. Pending and
 * no-match states explicitly preserve website order.
 * Obstruction avoidance reads geometry only and never operates the page layer.
 */

import { formatUnitPrice, speakUnitPrice } from './format.js';
import {
  clearAnnotation,
  placeAnnotationOnProductImage,
  syncAnnotationAccessibility
} from './annotation-placement.js';
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
const MENU_ICONS = {
  restore: '↺',
  'auto-asc': 'A',
  'mass-asc': 'kg',
  'volume-asc': 'L',
  'count-asc': '#',
  'total-asc': '$'
};
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
  button.setAttribute('aria-describedby', 'lups-status');
  button.setAttribute('aria-expanded', 'false');
  button.textContent = '';
  const buttonCopy = document.createElement('span');
  buttonCopy.className = 'lups-button-copy';
  const buttonKicker = document.createElement('span');
  buttonKicker.className = 'lups-button-kicker';
  buttonKicker.textContent = 'Unit price';
  const buttonText = document.createElement('span');
  buttonText.id = 'lups-menu-button-text';
  const fabGlyph = document.createElement('span');
  fabGlyph.className = 'lups-fab-glyph';
  fabGlyph.setAttribute('aria-hidden', 'true');
  fabGlyph.textContent = '⇅';
  buttonCopy.append(buttonKicker, buttonText);
  button.append(buttonCopy, fabGlyph);

  const triggerRow = document.createElement('div');
  triggerRow.className = 'lups-trigger-row';
  const flipButton = document.createElement('button');
  flipButton.id = 'lups-flip-direction';
  flipButton.type = 'button';
  flipButton.hidden = true;
  triggerRow.append(flipButton, button);

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
  menu.setAttribute('aria-label', 'Unit price sort');
  menu.setAttribute('aria-orientation', 'vertical');
  menu.setAttribute('role', 'menu');
  menu.tabIndex = -1;
  menu.style.cssText = 'opacity:1;visibility:visible;transform:none;max-height:min(70vh,560px);overflow-y:auto;';
  const menuOptions = document.createElement('div');
  menuOptions.id = 'lups-menu-options';
  // Presentation-only wrapper: the outer menu owns every option, including
  // the default-saving action that follows the radio-style sort choices.
  menuOptions.setAttribute('role', 'presentation');
  const defaultButton = document.createElement('button');
  defaultButton.id = 'lups-default';
  defaultButton.type = 'button';
  defaultButton.tabIndex = -1;
  defaultButton.setAttribute('role', 'menuitem');
  const defaultCopy = document.createElement('span');
  defaultCopy.className = 'lups-default-copy';
  const defaultIcon = document.createElement('span');
  defaultIcon.className = 'lups-option-icon';
  defaultIcon.setAttribute('aria-hidden', 'true');
  defaultIcon.textContent = '★';
  defaultButton.append(defaultCopy, defaultIcon);
  menu.append(menuOptions, defaultButton);
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

  const items = () => [...menu.querySelectorAll('[role="menuitemradio"],[role="menuitem"]')];
  function updateMenuCue() {
    const overflow = menu.scrollHeight - menu.clientHeight > 1;
    menuHost.dataset.lupsOverflow = String(overflow);
    menuCue.hidden = !overflow || menu.scrollTop + menu.clientHeight >= menu.scrollHeight - 1;
  }
  function closeMenu({ focusButton = false } = {}) {
    menuHost.hidden = true;
    root.dataset.lupsMenuOpen = 'false';
    button.setAttribute('aria-expanded', 'false');
    fabGlyph.textContent = '⇅';
    for (const item of items()) item.tabIndex = -1;
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
    root.dataset.lupsMenuOpen = 'true';
    button.setAttribute('aria-expanded', 'true');
    fabGlyph.textContent = '×';
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
    updateDefaultAction();
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
    const icon = document.createElement('span');
    icon.className = 'lups-option-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = MENU_ICONS[value];
    const tick = makeTick(nativeTick);
    tick.removeAttribute('data-testid');
    tick.dataset.lupsTick = '';
    icon.append(tick);
    item.append(copy, icon);
    item.addEventListener('click', () => chooseMenuOption(value));
    groupItems.append(item);
  }
  select.value = activeValue(state);
  root.dataset.lupsDefaultMode = select.value;
  function updateDefaultAction(saved = false) {
    const isDefault = root.dataset.lupsDefaultMode === select.value;
    defaultCopy.textContent = saved ? 'Default saved' : isDefault ? 'Current default' : 'Use as default';
    defaultButton.setAttribute('aria-label', saved
      ? `${buttonText.textContent} saved as this store's default`
      : isDefault
        ? `${buttonText.textContent} is this store's current default`
        : `Use ${buttonText.textContent} as this store's default`);
    // Keep the durable "this is the default" state separate from the brief
    // confirmation copy so the star remains gold whenever this mode matches.
    defaultButton.dataset.lupsCurrentDefault = String(isDefault);
    defaultButton.dataset.lupsSaved = String(saved);
  }
  select.addEventListener('change', () => choose(select.value, { focusButton: true, emit: true }));
  flipButton.addEventListener('click', () => {
    const match = /^(auto|mass|volume|count|total)-(asc|desc)$/.exec(select.value);
    if (!match) return;
    const partner = `${match[1]}-${match[2] === 'asc' ? 'desc' : 'asc'}`;
    choose(partner, { focusButton: true, emit: true });
  });
  defaultButton.addEventListener('click', () => {
    root.dataset.lupsDefaultMode = select.value;
    updateDefaultAction(true);
    root.dispatchEvent(new CustomEvent('gppu:default-change', {
      bubbles: true,
      detail: { value: select.value }
    }));
    liveStatus.textContent = `${buttonText.textContent} saved as this store's default`;
    setTimeout(() => updateDefaultAction(), 1600);
  });

  button.addEventListener('click', () => {
    if (menuHost.hidden) openMenu();
    else closeMenu({ focusButton: true });
  });
  menu.addEventListener('keydown', (event) => {
    const menuItems = items();
    const index = menuItems.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); closeMenu({ focusButton: true }); }
    else if (event.key === 'Tab') closeMenu();
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
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
  statusRow.setAttribute('role', 'tooltip');
  const status = document.createElement('span');
  status.id = 'lups-status';
  const liveStatus = document.createElement('output');
  liveStatus.id = 'lups-live-status';
  liveStatus.className = 'lups-visually-hidden';
  liveStatus.setAttribute('aria-live', 'polite');
  liveStatus.setAttribute('aria-atomic', 'true');
  const reloadButton = document.createElement('button');
  reloadButton.id = 'lups-reload';
  reloadButton.type = 'button';
  reloadButton.textContent = 'Reload page';
  reloadButton.setAttribute('aria-label', 'Reload page to capture current product data');
  reloadButton.hidden = true;
  reloadButton.addEventListener('click', () => onChange({ type: 'reload' }));
  statusRow.append(status, reloadButton);
  menuHost.append(menu, menuCue);
  inner.append(label, triggerRow, menuHost, select, statusRow, liveStatus);
  root.append(inner);
  (adapter.insert || ((control) => nativeSection.insertAdjacentElement('afterend', control)))(root);
  installObstructionAvoidance(root);
  root.dataset.lupsMenuOpen = 'false';
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
  // “Website order” still has useful diagnostics even though there is no sort
  // range to report. Keep those details in the hover/focus tooltip instead of
  // occupying permanent page space beside the compact floating control.
  const visibleParts = transitional || (restored ? [
    'Website order',
    ...(loadedProducts ? [loadedProducts] : []),
    ...(excluded ? [promotions] : [])
  ] : summaryParts);
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
  // Do not mirror this into `title`: Safari would show its own delayed tooltip
  // on top of the styled one, obscuring page content and duplicating the text.
  root.querySelector('#lups-menu-button').removeAttribute('title');
  const liveStatus = root.querySelector('#lups-live-status');
  const announcementStatus = announcementParts.join(' · ');
  if (liveStatus.textContent !== announcementStatus) liveStatus.textContent = announcementStatus;
  root.querySelector('#lups-status-row').dataset.lupsCritical = String(dataState === 'reload-needed');
  root.querySelector('#lups-reload').hidden = dataState !== 'reload-needed';
  root.dataset.lupsRestored = String(restored);
  root.dataset.lupsDataState = dataState || 'ready';
  root.dispatchEvent(new Event('gppu:layout-change'));
}

export function annotate(model) {
  const host = model.annotationHost || model.productCard || model.card;
  let note = host.querySelector('[data-lups-annotation]');
  // An overlay is useful only when it can communicate a price. Unavailable and
  // ambiguous products remain represented in the control summary without
  // covering their image with a long status label.
  if (!Number.isFinite(model.normalizedUnitPrice)) {
    clearAnnotation(host);
    return;
  }
  if (!note) {
    note = document.createElement('div');
    note.setAttribute('data-lups-annotation', '');
    note.className = 'lups-annotation';
  }
  placeAnnotationOnProductImage(host, note);
  const explicit = model.source === 'explicit-site-unit-price';
  note.dataset.source = explicit ? 'retailer' : 'calculated';
  // Provenance remains available to pointer and assistive-technology users,
  // but the always-visible badge is intentionally limited to the price.
  note.textContent = formatUnitPrice(model.normalizedUnitPrice, model.normalizedUnit);
  note.title = explicit ? 'Unit price supplied by the retailer API' : 'Calculated from retailer API package and price data';
  const description = `${note.title[0].toLowerCase()}${note.title.slice(1)}`;
  note.setAttribute('aria-label', `${speakUnitPrice(model.normalizedUnitPrice, model.normalizedUnit)}, ${description}`);
  syncAnnotationAccessibility(host, note);
}

export { clearAnnotation };

let adoptedStyleSheet = null;

export function injectStyles() {
  let style = document.getElementById('lups-styles');
  if (!style) {
    style = document.createElement('style');
    style.id = 'lups-styles';
    style.textContent = `
    #lups-control[data-lups-floating="true"]{position:fixed!important;z-index:2147483646!important;right:max(18px,env(safe-area-inset-right))!important;bottom:calc(max(18px,env(safe-area-inset-bottom)) + var(--lups-obstruction-lift,0px))!important;margin:0!important;color:#273244!important;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;transition:bottom .16s ease-out!important}
    #lups-control[data-lups-floating="true"]>div{position:relative!important;display:flex!important;align-items:flex-end!important;flex-direction:column!important;gap:8px!important}
    #lups-label,.lups-visually-hidden,.lups-button-copy{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
    .lups-trigger-row{display:flex!important;align-items:center!important;justify-content:flex-end!important;gap:8px!important}
    #lups-menu-button,#lups-flip-direction{box-sizing:border-box!important;display:grid!important;width:50px!important;min-width:50px!important;height:50px!important;min-height:50px!important;padding:0!important;place-items:center!important;border:1px solid #1e293b!important;border-radius:999px!important;background:#27364a!important;color:#fff!important;box-shadow:0 9px 24px #0f172a35,0 2px 6px #0f172a24!important;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;transition:transform .16s ease,box-shadow .16s ease,background .16s ease!important}
    #lups-menu-button:hover,#lups-menu-button[aria-expanded="true"]{background:#172033!important;box-shadow:0 12px 30px #0f172a42,0 3px 8px #0f172a2e!important;transform:translateY(-1px)!important}
    .lups-fab-glyph{font-size:22px!important;font-weight:500!important;line-height:1!important}
    #lups-flip-direction{width:50px!important;min-width:50px!important;height:50px!important;min-height:50px!important;border-color:#d7dee8!important;background:#fffffff5!important;color:#334155!important;box-shadow:0 5px 16px #0f172a1f,0 1px 3px #0f172a1a!important;font-size:21px!important;font-weight:650!important}
    #lups-flip-direction:hover{border-color:#aab5c4!important;background:#f8fafc!important;transform:translateY(-1px)!important}
    #lups-flip-direction[hidden],#lups-reload[hidden],#lups-status-row[hidden]{display:none!important}
    #lups-status-row{position:absolute!important;right:0!important;bottom:calc(100% + 11px)!important;box-sizing:border-box!important;display:flex!important;width:max-content!important;max-width:min(340px,calc(100vw - 24px))!important;align-items:center!important;gap:9px!important;padding:9px 11px!important;border:1px solid #d8dee8!important;border-radius:12px!important;background:#fffffff8!important;box-shadow:0 10px 28px #0f172a24,0 2px 6px #0f172a14!important;color:#334155!important;opacity:0!important;visibility:hidden!important;transform:translateY(4px)!important;pointer-events:none!important;transition:opacity .14s ease,transform .14s ease,visibility .14s ease!important}
    #lups-control[data-lups-menu-open="false"]:has(#lups-menu-button:hover) #lups-status-row[data-lups-critical="false"],#lups-control[data-lups-menu-open="false"]:has(#lups-menu-button:focus-visible) #lups-status-row[data-lups-critical="false"]{opacity:1!important;visibility:visible!important;transform:none!important}
    #lups-status-row[data-lups-critical="true"]{position:static!important;width:min(340px,calc(100vw - 24px))!important;border-color:#e6c36a!important;background:#fffaf0!important;color:#5f4615!important;opacity:1!important;visibility:visible!important;transform:none!important;pointer-events:auto!important}
    #lups-status{min-width:0!important;flex:1!important;font:550 11.5px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;text-align:left!important}
    #lups-reload{box-sizing:border-box!important;min-height:44px!important;padding:7px 11px!important;border:1px solid #c9a84d!important;border-radius:999px!important;background:#fff!important;color:#5f4615!important;font:700 11.5px/1.1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;white-space:nowrap!important}
    #lups-reload:hover{background:#fff3cf!important}
    #lups-menu-host[hidden]{display:none!important}
    #lups-menu-host{box-sizing:border-box!important;top:auto!important;right:0!important;bottom:calc(100% + 10px)!important;width:max-content!important;min-width:0!important}
    #lups-menu{box-sizing:border-box!important;width:max-content!important;max-width:calc(100vw - 24px)!important;max-height:min(72vh,calc(100dvh - var(--lups-obstruction-lift,0px) - 100px),540px)!important;padding:5px!important;border:0!important;border-radius:18px!important;background:transparent!important;color:#273244!important;box-shadow:none!important;scrollbar-width:thin!important}
    #lups-menu-options{display:flex!important;align-items:flex-end!important;flex-direction:column!important;gap:7px!important}
    #lups-menu-host[data-lups-overflow="true"] #lups-menu{padding-bottom:38px!important}
    .lups-menu-overflow-cue{position:absolute!important;right:5px!important;bottom:2px!important;display:flex!important;height:34px!important;box-sizing:border-box!important;align-items:flex-end!important;justify-content:center!important;padding:12px 10px 5px!important;border-radius:999px!important;background:linear-gradient(180deg,#ffffff00 0%,#fff 50%)!important;color:#526071!important;font:700 10px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;pointer-events:none!important}
    .lups-menu-overflow-cue[hidden]{display:none!important}
    .lups-menu-section,.lups-menu-group-items{display:contents!important}
    .lups-menu-group{display:none!important}
    #lups-menu [data-lups-value],#lups-default{box-sizing:border-box!important;display:flex!important;min-width:0!important;min-height:44px!important;align-items:center!important;justify-content:flex-end!important;gap:8px!important;padding:0!important;border:0!important;background:transparent!important;color:#334155!important;text-align:left!important;font-family:inherit!important;cursor:pointer!important}
    .lups-option-copy,.lups-default-copy{box-sizing:border-box!important;display:flex!important;min-width:0!important;min-height:34px!important;align-items:center!important;padding:7px 12px!important;border:1px solid #d9e0e9!important;border-radius:999px!important;background:#fffffff7!important;box-shadow:0 4px 13px #0f172a1c,0 1px 3px #0f172a14!important;color:#344256!important;font-size:12.5px!important;font-weight:600!important;line-height:1.15!important;white-space:nowrap!important;transition:transform .14s ease,border-color .14s ease,background .14s ease!important}
    .lups-option-title{overflow:hidden!important;font:inherit!important;text-overflow:ellipsis!important;white-space:nowrap!important}
    .lups-option-detail{display:none!important}
    .lups-option-icon{position:relative!important;box-sizing:border-box!important;display:grid!important;width:42px!important;min-width:42px!important;height:42px!important;place-items:center!important;border:1px solid #d7dee8!important;border-radius:999px!important;background:#fffffff8!important;box-shadow:0 5px 15px #0f172a20,0 1px 3px #0f172a18!important;color:#526071!important;font-size:11px!important;font-weight:750!important;line-height:1!important;transition:transform .14s ease,border-color .14s ease,background .14s ease!important}
    #lups-menu [data-lups-value]:hover .lups-option-copy,#lups-menu [data-lups-value]:focus-visible .lups-option-copy,#lups-default:hover .lups-default-copy,#lups-default:focus-visible .lups-default-copy{border-color:#aeb8c6!important;background:#fff!important;transform:translateX(-2px)!important}
    #lups-menu [data-lups-value]:hover .lups-option-icon,#lups-menu [data-lups-value]:focus-visible .lups-option-icon,#lups-default:hover .lups-option-icon,#lups-default:focus-visible .lups-option-icon{border-color:#aeb8c6!important;background:#f8fafc!important;transform:scale(1.04)!important}
    #lups-menu [data-lups-value][aria-checked="true"] .lups-option-copy{border-color:#aeb7d8!important;background:#eef0f8!important;color:#303a68!important}
    #lups-menu [data-lups-value][aria-checked="true"] .lups-option-icon{border-color:#27364a!important;background:#27364a!important;color:#fff!important}
    #lups-default{margin-top:7px!important}
    #lups-default[data-lups-current-default="true"] .lups-option-icon{border-color:#d5a72c!important;background:#f4c448!important;color:#5b3b00!important;box-shadow:0 5px 15px #8a5d0029,0 1px 3px #8a5d0024!important}
    #lups-control[data-lups-floating="true"] [data-lups-tick][hidden]{display:none!important}
    #lups-menu [data-lups-tick]{position:absolute!important;right:-3px!important;top:-3px!important;display:grid!important;width:15px!important;height:15px!important;place-items:center!important;border:2px solid #fff!important;border-radius:999px!important;background:#6366a8!important;color:#fff!important;font-size:9px!important;line-height:1!important}
    #lups-control :focus-visible{outline:3px solid #6476b8!important;outline-offset:3px!important}
    [data-lups-image-host]:has(>[data-lups-annotation][data-lups-placement="image-overlay"]){position:relative!important}
    .lups-annotation{box-sizing:border-box!important;display:block!important;width:max-content!important;max-width:100%!important;margin:6px 0!important;padding:4px 9px!important;border:1px solid #e2e8f0!important;border-radius:999px!important;background:#fffffff2!important;color:#374151!important;box-shadow:0 2px 8px #0f172a24!important;font:600 12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;text-align:center!important;white-space:nowrap!important}
    .lups-annotation[data-lups-placement="image-overlay"]{position:absolute!important;z-index:4!important;right:10px!important;bottom:10px!important;margin:0!important}
    @media(max-width:640px){#lups-control[data-lups-floating="true"]{right:max(10px,env(safe-area-inset-right))!important;bottom:calc(max(14px,env(safe-area-inset-bottom)) + var(--lups-obstruction-lift,0px))!important}#lups-menu-button{width:48px!important;min-width:48px!important;height:48px!important;min-height:48px!important}#lups-status-row{max-width:calc(100vw - 20px)!important}#lups-status-row[data-lups-critical="true"]{width:calc(100vw - 20px)!important}#lups-menu-host{position:absolute!important;right:0!important;bottom:calc(100% + 8px)!important}#lups-menu{max-width:calc(100vw - 20px)!important;max-height:min(72dvh,calc(100dvh - var(--lups-obstruction-lift,0px) - 88px),520px)!important}.lups-option-copy,.lups-default-copy{max-width:calc(100vw - 78px)!important}}
    @media(forced-colors:active){
      #lups-control[data-lups-floating="true"]{color:CanvasText!important}
      #lups-menu-button,#lups-flip-direction,#lups-reload,#lups-status-row,.lups-option-copy,.lups-default-copy,.lups-option-icon{border-width:2px!important;border-color:CanvasText!important;background:Canvas!important;color:CanvasText!important;box-shadow:none!important}
      #lups-menu [data-lups-value][aria-checked="true"] .lups-option-copy,#lups-menu [data-lups-value][aria-checked="true"] .lups-option-icon{border-color:Highlight!important;background:Highlight!important;color:HighlightText!important}
      .lups-menu-overflow-cue{background:Canvas!important;color:CanvasText!important}
      .lups-annotation{border-width:2px!important;border-style:solid!important;border-color:CanvasText!important;background:Canvas!important;color:CanvasText!important;box-shadow:none!important}
      #lups-control :focus-visible{outline:3px solid Highlight!important}
    }
    @media(prefers-contrast:more){#lups-menu-button,#lups-flip-direction,#lups-reload,#lups-status-row,.lups-option-copy,.lups-default-copy,.lups-option-icon{border-width:2px!important;box-shadow:none!important}.lups-annotation{border-width:2px!important}#lups-status{font-weight:650!important}}
    @media(prefers-reduced-motion:reduce){#lups-control[data-lups-floating="true"],#lups-menu-button,#lups-flip-direction,#lups-status-row,.lups-option-copy,.lups-option-icon{transition:none!important}}
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
