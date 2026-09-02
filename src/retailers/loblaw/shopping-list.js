import { claimRuntimeInstall } from '../../runtime/install.js';
import { createRetailerCartAdapter } from '../../runtime/retailer-cart-adapter.js';
import { createShoppingListRunner } from '../../runtime/shopping-list-runner.js';
import { readLoblawShoppingModel, readLoblawShoppingState } from './content.js';
import { isLoblawSearchPage } from './routes.js';

/* Superstore and No Frills share the same PC Express routes and card contract. */

function productIdForCard(card) {
  const link = card.querySelector('a[href*="/product/"],a[href*="/p/"]');
  const href = link?.getAttribute('href') || '';
  return href.match(/(?:product|p)\/([^/?#]+)/i)?.[1] || card.getAttribute('data-product-id') || null;
}

const cards = () => {
  const grid = document.querySelector(
    '[data-testid="listing-page-container"] [data-testid="product-grid-component"]'
  );
  if (!grid) return [];
  return [...grid.children].filter((card) => card.matches('[data-product-id]')
    || card.querySelector('a[href*="/product/"],a[href*="/p/"]'));
};

const LOBLAW_CART_ITEM = [
  '[data-testid="cart-item"]', '[data-testid^="cart-item-"]',
  '[data-testid*="cart-product"]', '[data-automation-id="cart-item"]'
].join(',');

export function loblawCartProductIds(root = document) {
  const ids = new Set();
  for (const item of root.querySelectorAll?.(LOBLAW_CART_ITEM) || []) {
    const ownId = item.getAttribute('data-product-id');
    if (ownId) ids.add(ownId);
    for (const card of item.querySelectorAll('[data-product-id]')) {
      const id = card.getAttribute('data-product-id');
      if (id) ids.add(id);
    }
    for (const anchor of item.querySelectorAll('a[href*="/product/"],a[href*="/p/"]')) {
      const id = (anchor.getAttribute('href') || '').match(/(?:product|p)\/([^/?#]+)/i)?.[1];
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

function loblawCartUrl() {
  const link = [...document.querySelectorAll('a[href*="/cart"]')].find((anchor) => {
    try { return new URL(anchor.href).origin === location.origin; } catch { return false; }
  });
  return link?.href || new URL('/en/cart', location.origin).href;
}

export function createLoblawShoppingAdapter() {
  return createRetailerCartAdapter({
    retailerName: location.hostname === 'www.nofrills.ca' ? 'No Frills' : 'Superstore',
    isSearchPage: isLoblawSearchPage,
    searchQuery: (url) => url.searchParams.get('search-bar'),
    searchUrl(query) {
      const url = new URL('/en/search', location.origin);
      url.searchParams.set('search-bar', String(query));
      return url.href;
    },
    cards,
    productIdForCard,
    trustedState: readLoblawShoppingState,
    trustedModel: readLoblawShoppingModel,
    isCartPage: (url) => url.pathname.split('/').filter(Boolean).at(-1)?.toLowerCase() === 'cart',
    cartUrl: loblawCartUrl,
    cartProductIds: loblawCartProductIds,
    cartItemEvidence: (root) => Boolean(root.querySelector(LOBLAW_CART_ITEM))
  });
}

export function installLoblawShoppingList() {
  if (!claimRuntimeInstall('loblaw-shopping-list')) return false;
  const retailerId = location.hostname === 'www.nofrills.ca' ? 'loblaw:no-frills' : 'loblaw:superstore';
  createShoppingListRunner({ retailerId, adapter: createLoblawShoppingAdapter() }).install();
  return true;
}
