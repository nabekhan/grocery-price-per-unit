import { claimRuntimeInstall } from '../../runtime/install.js';
import { createRetailerCartAdapter } from '../../runtime/retailer-cart-adapter.js';
import { createShoppingListRunner } from '../../runtime/shopping-list-runner.js';
import {
  modelForSaveOnApiProduct, normalizeSaveOnApiProduct,
  readSaveOnShoppingModel, readSaveOnShoppingSnapshot, readSaveOnShoppingState
} from './content.js';
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

const SEARCH_ORIGIN = 'https://storefrontgateway.saveonfoods.com';
const MAX_SEARCH_PRODUCTS = 500;
const SEARCH_PAGE_SIZE = 100;

function storeIdForSearch(url = new URL(location.href)) {
  return url.pathname.match(/\/rsid\/([^/]+)\/(?:results|cart)\/?$/i)?.[1] || null;
}

// Gateway responses have changed wrappers over time. Walk only a small,
// JSON-owned portion and reuse the exact sanitizer used by the capture bridge.
function responseProducts(payload) {
  const found = [];
  const seen = new WeakSet();
  const pending = [payload];
  for (let index = 0; index < pending.length && index < 5_000 && found.length < MAX_SEARCH_PRODUCTS; index += 1) {
    const value = pending[index];
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const id = value.sku || value.productId;
    const candidate = normalizeSaveOnApiProduct({
      id, name: value.name,
      currentPrice: value.priceNumeric ?? value.wholePrice ?? value.price,
      unitPrice: value.unitPrice || value.pricePerUnit,
      unitOfSize: value.unitOfSize,
      available: value.available ?? value.isAvailable
    }, id);
    if (candidate) { found.push(candidate); continue; }
    if (Array.isArray(value)) {
      pending.push(...value.slice(0, SEARCH_PAGE_SIZE));
    } else {
      for (const key of Object.keys(value).slice(0, 100)) pending.push(value[key]);
    }
  }
  return found;
}

export async function querySaveOnProducts(query, { onProgress } = {}) {
  const storeId = storeIdForSearch();
  if (!storeId || !query) return null;
  const products = new Map();
  // Bound the complete paginated preview, not just each individual request.
  // A stalled gateway must release the shared runner so the normal storefront
  // fallback (or a retry) remains available.
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeout = controller ? window.setTimeout(() => controller.abort(), 12_000) : null;
  // This is a public CORS GET observed from the storefront. Deliberately omit
  // credentials and headers: no tokens/cookies/request templates cross the
  // userscript boundary or persist anywhere.
  try {
    for (let skip = 0; skip < MAX_SEARCH_PRODUCTS; skip += SEARCH_PAGE_SIZE) {
      const url = new URL(`/api/stores/${encodeURIComponent(storeId)}/search`, SEARCH_ORIGIN);
      url.searchParams.set('q', query);
      url.searchParams.set('take', String(SEARCH_PAGE_SIZE));
      url.searchParams.set('skip', String(skip));
      const response = await fetch(url, {
        method: 'GET', credentials: 'omit', ...(controller ? { signal: controller.signal } : {})
      });
      if (!response.ok) return null;
      const page = responseProducts(await response.json());
      for (const product of page) products.set(product.id, product);
      onProgress?.(`Read ${products.size} verified Save-On results`);
      if (page.length < SEARCH_PAGE_SIZE) break;
    }
  } catch {
    return null;
  } finally {
    if (timeout !== null) window.clearTimeout(timeout);
  }
  return {
    status: 'complete', source: 'public-api',
    products: [...products.values()].map((product) => ({
      ...modelForSaveOnApiProduct(product), matched: true, addable: product.available !== false
    }))
  };
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
    trustedSnapshot: readSaveOnShoppingSnapshot,
    queryProducts: querySaveOnProducts,
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
