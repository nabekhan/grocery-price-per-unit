// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { annotate, createControl, updateStatus } from '../../src/ui/control.js';

describe('unit-price annotation lifecycle', () => {
  let card;

  beforeEach(() => {
    document.body.innerHTML = `<article id="card">
      <div data-testid="product-image"><img alt="Product"></div>
      <div class="details"><h3 data-testid="product-title">Product</h3></div>
    </article>`;
    card = document.querySelector('#card');
  });

  it('removes unavailable badges and recreates a price-only badge on recovery', () => {
    const model = {
      productCard: card,
      normalizedUnitPrice: 2,
      normalizedUnit: '$/kg',
      source: 'calculated-from-package'
    };
    annotate(model);
    let note = card.querySelector('[data-lups-annotation]');
    const image = card.querySelector('[data-testid="product-image"]');
    expect(note.parentElement).toBe(image);
    expect(image.hasAttribute('data-lups-image-host')).toBe(true);
    expect(note.dataset.lupsPlacement).toBe('image-overlay');
    expect(note.textContent).toBe('$2.00/kg');
    expect(note.dataset.source).toBe('calculated');
    expect(note.title).toBe('Calculated from retailer API package and price data');
    expect(note.getAttribute('aria-label')).toBe('$2.00 per kilogram, calculated from retailer API package and price data');

    annotate({ ...model, normalizedUnitPrice: null, source: 'unknown' });
    expect(card.querySelector('[data-lups-annotation]')).toBeNull();
    expect(image.hasAttribute('data-lups-image-host')).toBe(false);

    annotate({ ...model, normalizedUnitPrice: 1.6, normalizedUnit: '$/L', source: 'explicit-site-unit-price' });
    note = card.querySelector('[data-lups-annotation]');
    expect(note.parentElement).toBe(image);
    expect(note.textContent).toBe('$1.60/L');
    expect(note.dataset.source).toBe('retailer');
    expect(note.title).toBe('Unit price supplied by the retailer API');
    expect(note.getAttribute('aria-label')).toBe('$1.60 per litre, unit price supplied by the retailer API');
  });

  it('falls back safely and re-homes the same node when an image boundary appears', () => {
    card.innerHTML = '<div data-testid="product-title">Product</div>';
    const model = {
      productCard: card,
      normalizedUnitPrice: 2,
      normalizedUnit: '$/kg',
      source: 'calculated-from-package'
    };
    annotate(model);
    const note = card.querySelector('[data-lups-annotation]');
    expect(note.dataset.lupsPlacement).toBe('fallback');
    expect(note).toBe(card.lastElementChild);

    card.insertAdjacentHTML('afterbegin', '<div data-testid="product-image"><img alt="Product"></div>');
    annotate(model);
    expect(card.querySelector('[data-lups-annotation]')).toBe(note);
    expect(note.parentElement).toBe(card.querySelector('[data-testid="product-image"]'));
    expect(note.dataset.lupsPlacement).toBe('image-overlay');
  });

  it('mirrors an overlay outside an aria-hidden image without duplicating it visually', () => {
    const image = card.querySelector('[data-testid="product-image"]');
    image.setAttribute('aria-hidden', 'true');
    const model = {
      productCard: card,
      normalizedUnitPrice: 1.6,
      normalizedUnit: '$/L',
      source: 'explicit-site-unit-price'
    };

    annotate(model);
    const note = card.querySelector('[data-lups-annotation]');
    const accessible = card.querySelector('[data-lups-annotation-accessible]');
    expect(note.parentElement).toBe(image);
    expect(note.closest('[aria-hidden="true"]')).toBe(image);
    expect(accessible.parentElement).toBe(card);
    expect(accessible.getAttribute('role')).toBe('note');
    expect(accessible.textContent).toBe('$1.60 per litre, unit price supplied by the retailer API');
    expect(accessible.closest('[aria-hidden="true"]')).toBeNull();

    annotate({ ...model, normalizedUnitPrice: null, source: 'unknown' });
    expect(card.querySelector('[data-lups-annotation]')).toBeNull();
    expect(card.querySelector('[data-lups-annotation-accessible]')).toBeNull();
  });
});

describe('reload recovery control', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.stubGlobal('requestAnimationFrame', () => 1);
  });

  afterEach(() => {
    document.getElementById('lups-control')?.remove();
    vi.unstubAllGlobals();
  });

  it('shows the bounded recovery message and reload action only when needed', () => {
    const onChange = vi.fn();
    const control = createControl(onChange, { dimension: 'auto', direction: 'asc', restored: false });

    updateStatus(control, { total: 16, excluded: 2, dataState: 'reload-needed' });

    expect(control.dataset.lupsDataState).toBe('reload-needed');
    expect(control.querySelector('#lups-status').textContent).toBe(
      'Current product data was loaded before the userscript · Reload once · Website order preserved · 16 loaded products · 2 sponsored/ad tiles hidden'
    );
    expect(control.querySelector('#lups-live-status').textContent).toBe(
      'Current product data was loaded before the userscript · Reload once · Website order preserved · 16 loaded products · 2 sponsored/ad tiles hidden'
    );
    expect(control.querySelector('#lups-restore')).toBeNull();
    expect(control.querySelector('#lups-status-row').dataset.lupsCritical).toBe('true');
    const reload = control.querySelector('#lups-reload');
    expect(reload.hidden).toBe(false);
    onChange.mockClear();
    reload.click();
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith({ type: 'reload' });
  });
});
