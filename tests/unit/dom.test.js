// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { extractGrid, findProductGrid } from '../../src/retailers/loblaw/site.js';
import { MAX_RENDERED_CARDS } from '../../src/retailers/limits.js';

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

  it('accepts current titleless cards only with an image marker and product URL', () => {
    document.body.innerHTML = `<main data-testid="listing-page-container">
      <section data-testid="product-grid-component">
        <article><div data-testid="product-image"></div><a href="/en/milk/p/milk-one">Milk</a></article>
        <article><div data-testid="product-image"></div><a href="/en/eggs/p/eggs-one">Eggs</a></article>
        <article><div data-testid="product-image"></div><a href="/en/flour/p/flour-one">Flour</a></article>
        <article><div data-testid="product-image"></div><a href="/ordinary-page">Not a product</a></article>
      </section>
    </main>`;

    const grid = extractGrid(document, new Map([['milk-one', {
      id: 'milk-one', name: 'Milk', packageSizing: '1 L, $0.20/100ml',
      currentPrice: 2, regularPrice: null, displayPrice: '$2.00', weighted: false
    }]]));

    expect(grid.models).toHaveLength(3);
    expect(grid.models.map((model) => model.productId)).toEqual(['milk-one', 'eggs-one', 'flour-one']);
    expect(grid.models[0].dataSource).toBe('api');
    expect(grid.models[1].dataSource).toBe('missing-api');
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

  it('fails open before ancestor work on an oversized fallback title set', () => {
    document.body.innerHTML = `<main>${Array.from({ length: MAX_RENDERED_CARDS + 1 }, (_, index) =>
      `<article><h3 data-testid="product-title">Product ${index}</h3></article>`).join('')}</main>`;
    const subtreeQueries = vi.spyOn(Element.prototype, 'querySelectorAll');
    expect(findProductGrid(document)).toBeNull();
    expect(subtreeQueries).not.toHaveBeenCalled();
    subtreeQueries.mockRestore();
  });

  it('groups fallback cards without repeated ancestor subtree queries', () => {
    document.body.innerHTML = `<main>${Array.from({ length: 100 }, (_, index) =>
      `<article data-product-id="${index}"><h3 data-testid="product-title">Product ${index}</h3></article>`).join('')}</main>`;
    const subtreeQueries = vi.spyOn(Element.prototype, 'querySelectorAll');
    const match = findProductGrid(document);
    expect(match?.[1]).toHaveLength(100);
    expect(subtreeQueries).not.toHaveBeenCalled();
    subtreeQueries.mockRestore();
  });

  it('caps cumulative semantic-grid child inspection independently of matches', () => {
    const children = Array.from({ length: MAX_RENDERED_CARDS }, (_, index) => `<div>Ordinary ${index}</div>`).join('');
    document.body.innerHTML = `<main data-testid="listing-page-container">
      <section data-testid="product-grid-component">${children}</section>
      <section data-testid="product-grid-component">${children}</section>
    </main>`;
    const childQueries = vi.spyOn(Element.prototype, 'querySelector');
    expect(findProductGrid(document)).toBeNull();
    const titleQueries = childQueries.mock.calls.filter(([selector]) => selector === '[data-testid="product-title"]');
    expect(titleQueries.length).toBe(MAX_RENDERED_CARDS);
    childQueries.mockRestore();
  });
});
