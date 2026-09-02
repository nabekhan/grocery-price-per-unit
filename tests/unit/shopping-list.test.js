// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { chooseCheapestProduct, parseShoppingList } from '../../src/runtime/shopping-list-runner.js';
import {
  findWalmartAddButton,
  walmartCartProductIds
} from '../../src/retailers/walmart/shopping-list.js';
import {
  publishApiScanState,
  readApiScanModel,
  readApiScanState
} from '../../src/retailers/walmart/scan-state.js';

beforeEach(() => { document.body.innerHTML = ''; });

describe('shared shopping-list behavior', () => {
  it('accepts the documented comma-separated format and preserves duplicate quantities', () => {
    expect(parseShoppingList(' Peanut butter, bananas, jelly, water, bananas ')).toEqual([
      'Peanut butter', 'bananas', 'jelly', 'water', 'bananas'
    ]);
  });

  it('chooses the cheapest verified, addable product in the predominant comparable dimension', () => {
    const selected = chooseCheapestProduct([
      { matched: true, addable: true, productId: 'mass-expensive', name: 'Large jar', currentPrice: 9, normalizedUnitPrice: 5, dimension: 'mass' },
      { matched: true, addable: true, productId: 'volume-cheap', name: 'Drink', currentPrice: 1, normalizedUnitPrice: 1, dimension: 'volume' },
      { matched: true, addable: true, productId: 'mass-cheap', name: 'Small jar', currentPrice: 6, normalizedUnitPrice: 3, dimension: 'mass' },
      { matched: true, addable: false, productId: 'unavailable', name: 'Unavailable', currentPrice: 2, normalizedUnitPrice: 1, dimension: 'mass' }
    ]);
    expect(selected).toMatchObject({ productId: 'mass-cheap', selectedBy: 'mass' });
  });

  it('falls back to total price when verified products have no comparable unit price', () => {
    const selected = chooseCheapestProduct([
      { matched: true, addable: true, productId: 'large', name: 'Large', currentPrice: 8 },
      { matched: true, addable: true, productId: 'small', name: 'Small', currentPrice: 3 }
    ]);
    expect(selected).toMatchObject({ productId: 'small', selectedBy: 'total' });
  });
});

describe('Walmart shopping adapter boundaries', () => {
  it('keeps Add discovery inside the exact matched card', () => {
    document.body.innerHTML = `
      <article data-item-id="one"><button>Details</button></article>
      <article data-item-id="two"><button aria-label="Add Bananas to cart">Add</button></article>`;
    const first = document.querySelector('[data-item-id="one"]');
    const second = document.querySelector('[data-item-id="two"]');
    expect(findWalmartAddButton(first, { requireVisible: false })).toBeNull();
    expect(findWalmartAddButton(second, { requireVisible: false })?.getAttribute('aria-label')).toContain('Bananas');
  });

  it('publishes product identity only through the private trusted card model', () => {
    document.body.innerHTML = '<article data-item-id="page-forgery"></article>';
    const card = document.querySelector('article');
    publishApiScanState({ accepted: true, renderedCards: 1, apiCards: 1 }, [{
      card, matched: true, productId: 'api-id', name: 'API Bananas', currentPrice: 2,
      normalizedUnitPrice: 1.5, dimension: 'mass'
    }]);
    expect(readApiScanModel(readApiScanState(), card)).toMatchObject({
      productId: 'api-id', name: 'API Bananas', currentPrice: 2
    });
  });

  it('reconciles cart product IDs from card identity and Walmart product URLs', () => {
    document.body.innerHTML = `
      <section data-item-id="card-id"></section>
      <a href="/en/ip/bananas/url-id">Bananas</a>
      <a href="/help">Help</a>`;
    expect(walmartCartProductIds()).toEqual(['card-id', 'url-id']);
  });
});
