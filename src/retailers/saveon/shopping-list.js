import { claimRuntimeInstall } from '../../runtime/install.js';
import { createRetailerCartAdapter } from '../../runtime/retailer-cart-adapter.js';
import { createShoppingListRunner } from '../../runtime/shopping-list-runner.js';
import { readSaveOnShoppingModel, readSaveOnShoppingState } from './content.js';
import { isSaveOnSearchPage } from './routes.js';

const RESULT_ROUTE = /^(.*\/sm\/(?:pickup|delivery)\/rsid\/[^/]+)\/(?:results|cart)(?:\/)?$/i;
const cards = () => [...document.querySelectorAll('article[data-testid^="ProductCardWrapper-"]')]
  .map((article) => article.parentElement).filter(Boolean);
const productIdForCard = (card) => card.querySelector('article[data-testid^="ProductCardWrapper-"]')
  ?.dataset.testid?.match(/^ProductCardWrapper-(.+)$/)?.[1] || null;
const SAVEON_CART_ITEM = [
  '[data-testid="cart-item"]', '[data-testid^="cart-item-"]',
  '[data-testid*="CartItem"]', '[data-automation-id="cart-item"]'
].join(',');

function fulfillmentRoot(url = new URL(location.href)) {
  const direct = url.pathname.match(RESULT_ROUTE)?.[1];
  if (direct) return direct;
  const prefix = url.pathname.match(/^(.*\/sm\/(?:pickup|delivery)\/rsid\/[^/]+)(?:\/|$)/i)?.[1];
  if (prefix) return prefix;
  for (const anchor of document.querySelectorAll('a[href*="/rsid/"][href*="/results"]')) {
    try {
      const candidate = new URL(anchor.href);
      const match = candidate.origin === location.origin ? candidate.pathname.match(RESULT_ROUTE)?.[1] : null;
      if (match) return match;
    } catch { /* ignore malformed navigation links */ }
  }
  return null;
}

export function saveOnCartProductIds(root = document) {
  const ids = new Set();
  for (const item of root.querySelectorAll?.(SAVEON_CART_ITEM) || []) {
    for (const article of item.querySelectorAll('article[data-testid^="ProductCardWrapper-"]')) {
      const id = article.dataset.testid?.match(/^ProductCardWrapper-(.+)$/)?.[1];
      if (id) ids.add(id);
    }
    for (const anchor of item.querySelectorAll('a[href]')) {
      try {
        const url = new URL(anchor.href, location.origin);
        const queryId = url.searchParams.get('sku') || url.searchParams.get('productId');
        const pathId = url.pathname.match(/\/(?:product|products)\/[^/]*\/([^/?#]+)$/i)?.[1];
        if (queryId || pathId) ids.add(queryId || pathId);
      } catch { /* malformed retailer links are not cart evidence */ }
    }
  }
  return [...ids];
}

export function createSaveOnShoppingAdapter() {
  return createRetailerCartAdapter({
    retailerName: 'Save-On-Foods',
    isSearchPage: isSaveOnSearchPage,
    searchQuery: (url) => url.searchParams.get('q'),
    searchUrl(query, currentUrl) {
      const root = fulfillmentRoot(currentUrl);
      if (!root) return null;
      const url = new URL(`${root}/results`, location.origin);
      url.searchParams.set('q', String(query));
      return url.href;
    },
    searchUnavailableReason: 'Open a Save-On-Foods pickup or delivery results page, then continue.',
    cards,
    productIdForCard,
    trustedState: readSaveOnShoppingState,
    trustedModel: readSaveOnShoppingModel,
    isCartPage: (url) => url.pathname.split('/').filter(Boolean).at(-1)?.toLowerCase() === 'cart',
    cartUrl(currentUrl) {
      const link = [...document.querySelectorAll('a[href*="/cart"]')].find((anchor) => {
        try { return new URL(anchor.href).origin === location.origin; } catch { return false; }
      });
      const root = fulfillmentRoot(currentUrl);
      return link?.href || (root ? new URL(`${root}/cart`, location.origin).href : null);
    },
    cartUnavailableReason: 'Open the Save-On-Foods cart, then continue.',
    cartProductIds: saveOnCartProductIds,
    cartItemEvidence: (root) => Boolean(root.querySelector(SAVEON_CART_ITEM))
  });
}

export function installSaveOnShoppingList() {
  if (!claimRuntimeInstall('saveon-shopping-list')) return false;
  createShoppingListRunner({ retailerId: 'saveon', adapter: createSaveOnShoppingAdapter() }).install();
  return true;
}
