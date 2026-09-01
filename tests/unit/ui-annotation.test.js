// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { annotate } from '../../src/ui/control.js';

describe('unit-price annotation lifecycle', () => {
  let card;

  beforeEach(() => {
    document.body.innerHTML = '<article id="card"></article>';
    card = document.querySelector('#card');
  });

  it('replaces finite provenance with a clean unknown state and can recover', () => {
    const model = {
      productCard: card,
      normalizedUnitPrice: 2,
      normalizedUnit: '$/kg',
      source: 'calculated-from-package'
    };
    annotate(model);
    let note = card.querySelector('[data-lups-annotation]');
    expect(note.textContent).toBe('$2.00/kg · Calculated');
    expect(note.dataset.source).toBe('calculated');
    expect(note.title).toBe('Calculated from retailer API package and price data');
    expect(note.getAttribute('aria-label')).toBe('$2.00 per kilogram, calculated from retailer API package and price data');

    annotate({ ...model, normalizedUnitPrice: null, source: 'unknown' });
    note = card.querySelector('[data-lups-annotation]');
    expect(note.textContent).toBe('Unit price unavailable');
    expect(note.dataset.source).toBe('unknown');
    expect(note.hasAttribute('title')).toBe(false);
    expect(note.hasAttribute('aria-label')).toBe(false);

    annotate({ ...model, normalizedUnitPrice: 1.6, normalizedUnit: '$/L', source: 'explicit-site-unit-price' });
    expect(note.textContent).toBe('$1.60/L · Retailer');
    expect(note.dataset.source).toBe('retailer');
    expect(note.title).toBe('Unit price supplied by the retailer API');
    expect(note.getAttribute('aria-label')).toBe('$1.60 per litre, unit price supplied by the retailer API');
  });
});
