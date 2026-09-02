// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { chooseCheapestProduct, parseShoppingList } from '../../src/runtime/shopping-list-runner.js';
import { createRetailerCartAdapter } from '../../src/runtime/retailer-cart-adapter.js';
import {
  findWalmartAddButton,
  walmartCartProductIds
} from '../../src/retailers/walmart/shopping-list.js';
import { loblawCartProductIds } from '../../src/retailers/loblaw/shopping-list.js';
import { saveOnCartProductIds } from '../../src/retailers/saveon/shopping-list.js';
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

  it('pauses instead of choosing from an unconfirmed partial first page', async () => {
    const originalScrollTo = window.scrollTo;
    const scrollYDescriptor = Object.getOwnPropertyDescriptor(window, 'scrollY');
    const heightDescriptor = Object.getOwnPropertyDescriptor(document.documentElement, 'scrollHeight');
    let scrollPosition = 0;
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollPosition });
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, get: () => 5_000 });
    window.scrollTo = (_x, y) => { scrollPosition = Number(y) || 0; };
    try {
      const adapter = createRetailerCartAdapter({
        retailerName: 'Fixture', isSearchPage: () => true, searchQuery: () => 'milk',
        searchUrl: () => location.href, cards: () => [], productIdForCard: () => null,
        trustedState: () => null, trustedModel: () => null, isCartPage: () => false,
        cartUrl: () => location.href, cartProductIds: () => [], cartItemEvidence: () => false,
        maximumScrollSteps: 2, productSettleMs: 0
      });
      await expect(adapter.collectProducts()).resolves.toMatchObject({ status: 'incomplete' });
    } finally {
      window.scrollTo = originalScrollTo;
      if (scrollYDescriptor) Object.defineProperty(window, 'scrollY', scrollYDescriptor);
      else delete window.scrollY;
      if (heightDescriptor) Object.defineProperty(document.documentElement, 'scrollHeight', heightDescriptor);
      else delete document.documentElement.scrollHeight;
    }
  });

  it('does not treat a vanished Add button or cart subtotal as Add confirmation', async () => {
    document.body.innerHTML = `
      <article data-product-id="milk"><button>Add milk</button></article>
      <a href="/cart" aria-label="Cart total $42.50">Cart total $42.50</a>`;
    const card = document.querySelector('article');
    const button = card.querySelector('button');
    const cartLink = document.querySelector('a[href="/cart"]');
    button.getClientRects = () => [{ width: 80, height: 44 }];
    cartLink.getClientRects = () => [{ width: 120, height: 44 }];
    button.addEventListener('click', () => button.remove());
    card.scrollIntoView = () => {};
    const originalScrollTo = window.scrollTo;
    window.scrollTo = () => {};
    try {
      const state = { accepted: true };
      const adapter = createRetailerCartAdapter({
        retailerName: 'Fixture', isSearchPage: () => true, searchQuery: () => 'milk',
        searchUrl: () => location.href, cards: () => [card],
        productIdForCard: (element) => element.dataset.productId,
        trustedState: () => state,
        trustedModel: (_state, element) => element === card ? {
          matched: true, productId: 'milk', name: 'Milk 1 L', currentPrice: 4,
          normalizedUnitPrice: 4, dimension: 'volume'
        } : null,
        isCartPage: () => false, cartUrl: () => location.href,
        cartProductIds: () => [], cartItemEvidence: () => false,
        productSettleMs: 0, addVerifyMs: 20
      });
      await expect(adapter.addProduct({
        productId: 'milk', name: 'Milk 1 L', currentPrice: 4,
        normalizedUnitPrice: 4, dimension: 'volume'
      })).resolves.toMatchObject({ status: 'missed' });
    } finally {
      window.scrollTo = originalScrollTo;
    }
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
      <section data-testid="cart-item" data-item-id="card-id">
        <a href="/en/ip/bananas/url-id">Bananas</a>
      </section>
      <aside><a href="/en/ip/recommended/recommendation-id">Recommendation</a></aside>`;
    expect(walmartCartProductIds()).toEqual(['card-id', 'url-id']);
  });

  it('restricts Loblaw and Save-On reconciliation to actual cart items', () => {
    document.body.innerHTML = `
      <article data-testid="cart-item"><a href="/product/cart-loblaw">Cart item</a></article>
      <article data-testid="CartItem-saveon"><a href="/product/milk?sku=cart-saveon">Cart item</a></article>
      <aside><a href="/product/recommendation">Recommendation</a></aside>`;
    expect(loblawCartProductIds()).toEqual(['cart-loblaw']);
    expect(saveOnCartProductIds()).toEqual(['cart-saveon']);
  });
});
