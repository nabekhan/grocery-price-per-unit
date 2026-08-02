const LABELS = { mass: '$/kg', volume: '$/L', count: '$/each', total: 'total price' };
const OPTIONS = [
  ['restore', 'Website order', null, null, 'Website order', 'Use the retailer’s relevance sorting'],
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

function activeValue(state) {
  return state.restored ? 'restore' : `${state.dimension}-${state.direction}`;
}

function makeTick(template) {
  if (template) return template.cloneNode(true);
  const tick = document.createElement('span');
  tick.className = 'lups-menu-tick';
  tick.setAttribute('aria-hidden', 'true');
  tick.textContent = '✓';
  return tick;
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
  button.removeAttribute('aria-controls');
  button.setAttribute('aria-labelledby', 'lups-label lups-menu-button');
  button.setAttribute('aria-expanded', 'false');
  const buttonText = button.querySelector('p') || button.querySelector('span') || button;
  buttonText.id = 'lups-menu-button-text';

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
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-orientation', 'vertical');
  menu.tabIndex = -1;
  menu.style.cssText = 'opacity:1;visibility:visible;transform:none;max-height:min(70vh,560px);overflow-y:auto;';

  const nativeItem = nativeMenuList?.querySelector('[data-testid="menu-item"]');
  const nativeTick = nativeMenuList?.querySelector('[data-testid="menu-tick-icon"]');
  const select = document.createElement('select');
  select.id = 'lups-mode';
  select.setAttribute('aria-hidden', 'true');
  select.tabIndex = -1;
  select.hidden = true;

  function choose(value) {
    const option = OPTIONS.find(([key]) => key === value) || OPTIONS[0];
    select.value = option[0];
    buttonText.textContent = option[4];
    for (const item of menu.querySelectorAll('[data-lups-value]')) {
      const chosen = item.dataset.lupsValue === option[0];
      item.setAttribute('aria-checked', String(chosen));
      item.querySelector('[data-lups-tick]')?.toggleAttribute('hidden', !chosen);
    }
    menuHost.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (option[0] === 'restore') onChange({ type: 'restore' });
    else onChange({ type: 'sort', dimension: option[2], direction: option[3] });
  }

  for (const [value, title, , , , detail] of OPTIONS) {
    select.add(new Option(`${title}: ${detail}`, value));
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
    item.addEventListener('click', () => choose(value));
    menu.append(item);
  }
  select.value = activeValue(state);
  select.addEventListener('change', () => choose(select.value));

  button.addEventListener('click', () => {
    const opening = menuHost.hidden;
    menuHost.hidden = !opening;
    button.setAttribute('aria-expanded', String(opening));
    if (opening) menu.querySelector(`[data-lups-value="${select.value}"]`)?.focus();
  });
  menu.addEventListener('keydown', (event) => {
    const items = [...menu.querySelectorAll('[data-lups-value]')];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') { menuHost.hidden = true; button.setAttribute('aria-expanded', 'false'); button.focus(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      items[(index + delta + items.length) % items.length].focus();
    } else if (event.key === 'Home') { event.preventDefault(); items[0].focus(); }
    else if (event.key === 'End') { event.preventDefault(); items.at(-1).focus(); }
  });
  document.addEventListener('click', (event) => {
    if (!root.contains(event.target)) { menuHost.hidden = true; button.setAttribute('aria-expanded', 'false'); }
  });

  const status = document.createElement('output');
  status.id = 'lups-status';
  status.setAttribute('aria-live', 'polite');
  menuHost.append(menu);
  inner.append(label, button, menuHost, select, status);
  root.append(inner);
  (adapter.insert || ((control) => nativeSection.insertAdjacentElement('afterend', control)))(root);
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

export function updateStatus(root, { dimension, sortable, incompatible, unknown, total, excluded = 0, restored = false }) {
  root.querySelector('#lups-status').textContent = restored
    ? `Website order restored for ${total} loaded products.`
    : `Sorted ${sortable} products by ${LABELS[dimension]}${dimension === 'total' ? ' (unit prices unavailable or manually selected)' : ''}. ${incompatible} incompatible; ${unknown} unknown${excluded ? `; ${excluded} excluded` : ''}. ${total} loaded products total.`;
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
    const origin = explicit ? 'retailer API' : 'calculated from retailer API';
    note.dataset.source = explicit ? 'retailer' : 'calculated';
    note.textContent = `${model.normalizedUnitPrice.toFixed(2)} ${model.normalizedUnit} (${origin})`;
  } else {
    note.dataset.source = 'unknown';
    note.textContent = model.source === 'ambiguous' ? 'Unit price ambiguous' : 'Unit price unavailable';
  }
}

export function injectStyles() {
  if (document.getElementById('lups-styles')) return;
  const style = document.createElement('style');
  style.id = 'lups-styles';
  style.textContent = `
    #lups-control[data-lups-floating="true"]{position:fixed!important;z-index:2147483646!important;right:18px!important;bottom:18px!important;margin:0!important;color:#17221d;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    #lups-control[data-lups-floating="true"]>div{position:relative!important;display:flex!important;align-items:center!important;gap:10px!important}
    #lups-label{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
    #lups-menu-button{box-sizing:border-box!important;display:inline-flex!important;align-items:center!important;justify-content:space-between!important;gap:10px!important;min-width:190px!important;min-height:42px!important;padding:9px 12px!important;border:1px solid #9eb9a9!important;border-radius:10px!important;background:linear-gradient(180deg,#f8fcf9 0%,#edf7f0 100%)!important;color:#155f45!important;box-shadow:0 1px 2px #163f2b14!important;font:600 14px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;white-space:nowrap!important;transition:border-color .15s ease,box-shadow .15s ease,background .15s ease!important}
    #lups-menu-button:hover{border-color:#438a6d!important;background:#e8f5ec!important;box-shadow:0 2px 5px #163f2b1f!important}
    #lups-menu-button[aria-expanded="true"]{border-color:#197454!important;background:#e4f3e9!important;box-shadow:0 0 0 3px #1b805326!important}
    #lups-menu-button-text{overflow:hidden!important;text-overflow:ellipsis!important}
    #lups-control[data-lups-floating="true"] #lups-status{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
    #lups-control[data-lups-floating="true"] [data-lups-tick][hidden]{display:none!important}
    #lups-menu-host[hidden]{display:none!important}
    #lups-menu-host{box-sizing:border-box!important;top:auto!important;right:0!important;bottom:calc(100% + 8px)!important;width:min(350px,calc(100vw - 24px))!important;min-width:0!important}
    #lups-menu{box-sizing:border-box!important;width:100%!important;padding:8px!important;border:1px solid #d8e2dc!important;border-radius:14px!important;background:#fff!important;color:#17221d!important;box-shadow:0 18px 48px #14251d2e,0 3px 10px #14251d1f!important}
    #lups-menu [data-lups-value]{box-sizing:border-box!important;display:flex!important;align-items:center!important;justify-content:space-between!important;gap:16px!important;width:100%!important;min-height:46px!important;padding:6px 10px!important;border:0!important;border-radius:9px!important;background:transparent!important;color:inherit!important;text-align:left!important;font-family:inherit!important}
    #lups-menu [data-lups-value]:hover,#lups-menu [data-lups-value]:focus-visible{background:#f0f7f2!important}
    #lups-menu [data-lups-value][aria-checked="true"]{background:#e4f3e9!important;color:#0e6245!important}
    #lups-menu [data-lups-value="auto-asc"],#lups-menu [data-lups-value="mass-asc"],#lups-menu [data-lups-value="volume-asc"],#lups-menu [data-lups-value="count-asc"],#lups-menu [data-lups-value="total-asc"]{margin-top:5px!important}
    .lups-option-copy{display:flex;min-width:0;flex:1;flex-direction:column;gap:2px}
    .lups-option-title{font-size:14px;line-height:1.2;font-weight:650}
    .lups-option-detail{overflow:hidden;color:#607068;font-size:11.5px;line-height:1.25;font-weight:450;text-overflow:ellipsis;white-space:nowrap}
    #lups-menu [aria-checked="true"] .lups-option-detail{color:#39735e}
    #lups-menu [data-lups-tick]{flex:0 0 auto;color:#197454}
    #lups-control :focus-visible{outline:3px solid #1769aa;outline-offset:2px}
    .lups-annotation{box-sizing:border-box!important;display:block!important;width:max-content!important;max-width:100%!important;margin:6px 0!important;padding:4px 8px!important;border:1px solid #9bc9ae!important;border-radius:999px!important;background:#edf8ef!important;color:#184d27!important;font:650 12px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important}
    .lups-annotation[data-source="calculated"]{border-color:#1769aa;background:#eef6fc;color:#164b72}.lups-annotation[data-source="unknown"]{border-color:#777;background:#f4f4f4;color:#555}
    @media(max-width:640px){#lups-control[data-lups-floating="true"]{right:10px!important;bottom:14px!important}#lups-menu-button{min-width:0!important;width:158px!important;min-height:40px!important;padding:8px 10px!important;font-size:13px!important}#lups-menu-host{position:fixed!important;right:8px!important;bottom:64px!important;width:calc(100vw - 16px)!important}#lups-menu{max-height:min(82vh,640px)!important}}
  `;
  document.head.append(style);
}
