// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { extractGrid } from '../../src/retailers/loblaw/site.js';

const fixture = fs.readFileSync('tests/fixtures/product-grid.html', 'utf8');
beforeEach(() => { document.documentElement.innerHTML = fixture.match(/<html>([\s\S]*)<\/html>/)[1]; });

describe('sanitized current-card variants', () => {
  it('finds one grid and extracts all cards', () => {
    const grid = extractGrid(document);
    expect(grid.models).toHaveLength(8);
    expect(grid.models.every((model) => model.source === 'unknown')).toBe(true);
    expect(grid.models.every((model) => model.currentPrice === null)).toBe(true);
    expect(grid.models.every((model) => model.dataSource === 'missing-api')).toBe(true);
  });

  it('prefers an exact product-ID API record over rendered price text', () => {
    const products = new Map([['flour', {
      id: 'flour',
      name: 'API Flour',
      packageSizing: '2 kg, $0.20/100g',
      currentPrice: 4,
      regularPrice: 5,
      memberPrice: null,
      displayPrice: '$4.00'
    }]]);
    const flour = extractGrid(document, products).models.find((model) => model.productId === 'flour');
    expect(flour.name).toBe('API Flour');
    expect(flour.currentPrice).toBe(4);
    expect(flour.normalizedUnitPrice).toBe(2);
    expect(flour.dataSource).toBe('api');
  });

  it('does not calculate a variable-weight unit price from an estimated total', () => {
    const products = new Map([['chicken', {
      id: 'chicken', name: 'API Chicken', packageSizing: 'approximately 800 g',
      currentPrice: 12, regularPrice: null, memberPrice: null, displayPrice: 'approximately $12.00', weighted: true
    }]]);
    const chicken = extractGrid(document, products).models.find((model) => model.productId === 'chicken');
    expect(chicken.currentPrice).toBeNull();
    expect(chicken.normalizedUnitPrice).toBeNull();
    expect(chicken.source).toBe('unknown');
  });
});
