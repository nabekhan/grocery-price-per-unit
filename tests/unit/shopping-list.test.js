// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseCheapestProduct, parseShoppingList } from '../../src/runtime/shopping-list-runner.js';
import { createRetailerCartAdapter } from '../../src/runtime/retailer-cart-adapter.js';
import { createWalmartShoppingAdapter } from '../../src/retailers/walmart/shopping-list.js';
import { createLoblawShoppingAdapter } from '../../src/retailers/loblaw/shopping-list.js';
import { querySaveOnProducts } from '../../src/retailers/saveon/shopping-list.js';
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

  it('prefers exact query matches before comparing unit prices', () => {
    const selected = chooseCheapestProduct([
      { matched: true, addable: true, productId: 'noodles', name: 'Egg White Noodles', currentPrice: 2,
        normalizedUnitPrice: 2, dimension: 'mass' },
      { matched: true, addable: true, productId: 'eggs', name: 'Large Grade A Eggs', currentPrice: 4,
        normalizedUnitPrice: 0.33, dimension: 'count' }
    ], 'unit', 'eggs');
    expect(selected).toMatchObject({ productId: 'eggs', selectedBy: 'count' });
  });

  it('uses singular/plural query matching when the retailer title differs', () => {
    const selected = chooseCheapestProduct([
      { matched: true, addable: true, productId: 'bread', name: 'Plain Bread', currentPrice: 1,
        normalizedUnitPrice: 1, dimension: 'mass' },
      { matched: true, addable: true, productId: 'fruit', name: 'Fresh Banana', currentPrice: 3,
        normalizedUnitPrice: 2, dimension: 'mass' }
    ], 'unit', 'bananas');
    expect(selected).toMatchObject({ productId: 'fruit' });
  });

  it('exposes only API operations and fails closed when a capability is absent', async () => {
    const adapter = createRetailerCartAdapter({ retailerName: 'Fixture' });
    expect(adapter).not.toHaveProperty('navigate');
    expect(adapter).not.toHaveProperty('collectProducts');
    expect(adapter).not.toHaveProperty('addProduct');
    expect(adapter).not.toHaveProperty('reviewCart');
    await expect(adapter.queryProducts('milk')).resolves.toBeNull();
    await expect(adapter.directAddProduct({ productId: 'milk' })).resolves.toBeNull();
    await expect(adapter.directReviewCart([{ productId: 'milk' }])).resolves.toBeNull();
  });

  it('turns a direct Loblaw PCX result into an eligible unit-price candidate without cards', async () => {
    const adapter = createLoblawShoppingAdapter({
      queryProducts: async () => ({ status: 'complete', products: [{
        id: 'direct-milk_EA', name: 'Direct Milk', packageSizing: '1 L, $2.00/L',
        currentPrice: 2, regularPrice: null, weighted: false
      }] })
    });

    const result = await adapter.queryProducts('milk');
    expect(result).toMatchObject({ status: 'complete', products: [expect.objectContaining({
      matched: true, addable: true, productId: 'direct-milk_EA', normalizedUnitPrice: 2, dimension: 'volume'
    })] });
    expect(chooseCheapestProduct(result.products)).toMatchObject({ productId: 'direct-milk_EA', selectedBy: 'volume' });
  });

  it('uses a fully capable Loblaw API adapter without scrolling product cards', async () => {
    const addProduct = vi.fn(async () => ({ status: 'added' }));
    const readCart = vi.fn(async (ids) => ({ inspectable: true, presentProductIds: ids }));
    const adapter = createLoblawShoppingAdapter({ addProduct, readCart });
    const originalScrollTo = window.scrollTo;
    let scrolls = 0;
    window.scrollTo = () => { scrolls += 1; };
    try {
      await expect(adapter.directAddProduct({ productId: 'api-milk' })).resolves.toEqual({ status: 'added' });
      await expect(adapter.directReviewCart([{ productId: 'api-milk' }])).resolves.toMatchObject({
        inspectable: true, presentProductIds: ['api-milk']
      });
      expect(addProduct).toHaveBeenCalledWith('api-milk');
      expect(readCart).toHaveBeenCalledWith(['api-milk']);
      expect(scrolls).toBe(0);
    } finally { window.scrollTo = originalScrollTo; }
  });

  it('fails closed when the public Save-On query cannot be read', async () => {
    const originalFetch = globalThis.fetch;
    const originalUrl = location.href;
    history.replaceState({}, '', '/sm/pickup/rsid/6647/results?q=milk');
    globalThis.fetch = async () => { throw new Error('network'); };
    try { await expect(querySaveOnProducts('bananas')).resolves.toBeNull(); }
    finally {
      globalThis.fetch = originalFetch;
      history.replaceState({}, '', originalUrl);
    }
  });

  it('pages the public Save-On query without credentials and keeps explicit unavailable items out', async () => {
    const originalFetch = globalThis.fetch;
    const originalUrl = location.href;
    history.replaceState({}, '', '/sm/pickup/rsid/6647/results?q=milk');
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      sku: `milk-${index}`, name: `Milk ${index} 1 L`, priceNumeric: 3 + index,
      unitPrice: `$${3 + index}/L`, unitOfSize: { size: 1, abbreviation: 'L' }
    }));
    firstPage[0] = { sku: 'unavailable', name: 'Unavailable milk 1 L', priceNumeric: 1, unitPrice: '$1/L', available: false };
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      return { ok: true, json: async () => calls.length === 1 ? { products: firstPage } : { products: [] } };
    };
    try {
      const result = await querySaveOnProducts('milk');
      expect(calls).toHaveLength(2);
      expect(calls[0].options).toMatchObject({ method: 'GET', credentials: 'omit' });
      expect(calls[0].url).toContain('take=100');
      expect(calls[1].url).toContain('skip=100');
      expect(result).toMatchObject({ status: 'complete', source: 'public-api' });
      expect(result.products).toHaveLength(100);
      expect(result.products.find((product) => product.productId === 'unavailable')).toMatchObject({ addable: false });
    } finally {
      globalThis.fetch = originalFetch;
      history.replaceState({}, '', originalUrl);
    }
  });

});

describe('Walmart shopping adapter boundaries', () => {
  it('does not expose removed page-navigation or DOM cart operations', async () => {
    const adapter = createWalmartShoppingAdapter();
    expect(adapter).not.toHaveProperty('navigate');
    expect(adapter).not.toHaveProperty('collectProducts');
    expect(adapter).not.toHaveProperty('addProduct');
    expect(adapter).not.toHaveProperty('reviewCart');
    await expect(adapter.queryProducts('bananas')).resolves.toBeNull();
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
});
