import { claimRuntimeInstall } from '../../runtime/install.js';
import { createRetailerCartAdapter, findCardAddButton } from '../../runtime/retailer-cart-adapter.js';
import { createShoppingListRunner } from '../../runtime/shopping-list-runner.js';
import { readApiScanModel, readApiScanState } from './scan-state.js';
import { readWalmartShoppingSnapshot } from './content.js';
import { isWalmartSearchPage } from './routes.js';

/* Walmart owns only its stable route, card, and cart identity selectors. */

const cards = () => document.querySelectorAll('[data-item-id]');
const productIdForCard = (card) => card.getAttribute('data-item-id') || null;
const WALMART_CART_ITEM = [
  '[data-testid="cart-item"]', '[data-testid^="cart-item-"]',
  '[data-automation-id="cart-item"]', '[data-automation-id^="cart-item-"]'
].join(',');

export const findWalmartAddButton = findCardAddButton;

export function walmartCartProductIds(root = document) {
  const ids = new Set();
  for (const item of root.querySelectorAll?.(WALMART_CART_ITEM) || []) {
    const ownId = productIdForCard(item);
    if (ownId) ids.add(ownId);
    for (const card of item.querySelectorAll('[data-item-id]')) {
      const id = productIdForCard(card);
      if (id) ids.add(id);
    }
    for (const anchor of item.querySelectorAll('a[href*="/ip/"]')) {
      try {
        const segments = new URL(anchor.href, location.origin).pathname.split('/').filter(Boolean);
        const id = segments.includes('ip') ? segments.at(-1) : null;
        if (id && id !== 'ip') ids.add(decodeURIComponent(id));
      } catch { /* malformed retailer links are not cart evidence */ }
    }
  }
  return [...ids];
}

function walmartCartUrl() {
  const link = [...document.querySelectorAll('a[href*="/cart"]')].find((anchor) => {
    try { return new URL(anchor.href).origin === location.origin; } catch { return false; }
  });
  return link?.href || new URL('/en/cart', location.origin).href;
}

export function createWalmartShoppingAdapter() {
  return createRetailerCartAdapter({
    retailerName: 'Walmart',
    isSearchPage: isWalmartSearchPage,
    searchQuery: (url) => url.searchParams.get('q'),
    searchUrl(query) {
      const url = new URL('/en/search', location.origin);
      url.searchParams.set('q', String(query));
      return url.href;
    },
    cards,
    productIdForCard,
    trustedState: readApiScanState,
    trustedModel: readApiScanModel,
    trustedSnapshot: readWalmartShoppingSnapshot,
    isCartPage: (url) => url.pathname.split('/').filter(Boolean).at(-1)?.toLowerCase() === 'cart',
    cartUrl: walmartCartUrl,
    cartProductIds: walmartCartProductIds,
    cartItemEvidence: (root) => Boolean(root.querySelector(WALMART_CART_ITEM))
  });
}

export function installWalmartShoppingList() {
  if (!claimRuntimeInstall('walmart-shopping-list')) return false;
  createShoppingListRunner({ retailerId: 'walmart', adapter: createWalmartShoppingAdapter() }).install();
  return true;
}
