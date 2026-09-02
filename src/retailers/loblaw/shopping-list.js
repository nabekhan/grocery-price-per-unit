import { claimRuntimeInstall } from '../../runtime/install.js';
import { createRetailerCartAdapter } from '../../runtime/retailer-cart-adapter.js';
import { createShoppingListRunner } from '../../runtime/shopping-list-runner.js';
import { readLoblawShoppingModel, readLoblawShoppingSnapshot, readLoblawShoppingState } from './content.js';
import { isLoblawSearchPage } from './routes.js';
import { modelForApiProduct } from './site.js';

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
  return link?.href || new URL('/en/cartReview', location.origin).href;
}

export function createLoblawShoppingAdapter(capture) {
  return createRetailerCartAdapter({
    retailerName: location.hostname === 'www.nofrills.ca' ? 'No Frills' : 'Superstore',
    isSearchPage: isLoblawSearchPage,
    searchQuery: (url) => url.searchParams.get('search-bar'),
    searchUrl(query) {
      const url = new URL('/en/search', location.origin);
      url.searchParams.set('search-bar', String(query));
      // Preserve the page's current pickup and cart identity if API replay is
      // unavailable. This keeps the conservative UI fallback in the same
      // store/cart instead of silently opening an unscoped search.
      for (const key of ['storeId', 'cartId']) {
        const value = new URL(location.href).searchParams.get(key);
        if (value) url.searchParams.set(key, value);
      }
      return url.href;
    },
    cards,
    productIdForCard,
    trustedState: readLoblawShoppingState,
    trustedModel: readLoblawShoppingModel,
    trustedSnapshot: readLoblawShoppingSnapshot,
    // The capture capability stays in the userscript module closure. It is
    // optional because a late-installed script may have missed the storefront
    // search request; the shared adapter then uses its established fallback.
    queryProducts: typeof capture?.queryProducts === 'function'
      ? async (query) => {
        const response = await capture.queryProducts(query);
        if (response?.status !== 'complete' || !Array.isArray(response.products)) return response;
        // Query capture transports only bounded raw retailer facts. Convert
        // them through the one shared Loblaw parser before the generic runner
        // chooses a comparable unit price; direct search does not need cards
        // (or their images) to exist.
        return {
          status: 'complete',
          products: response.products.map((product) => {
            const model = modelForApiProduct(product);
            return model ? { ...model, matched: true, addable: true } : null;
          }).filter(Boolean)
        };
      }
      : null,
    // These capabilities are intentionally captured in the page-world module
    // closure.  They are null unless an observed authenticated cart request
    // and pickup/store proof make the operation safe to reproduce.
    addProduct: typeof capture?.addProduct === 'function'
      ? async (candidate) => capture.addProduct(candidate?.productId)
      : null,
    reviewCart: typeof capture?.readCart === 'function'
      ? async (candidates) => capture.readCart(candidates.map((candidate) => candidate?.productId).filter(Boolean))
      : null,
    isCartPage: (url) => ['cart', 'cartreview'].includes(
      url.pathname.split('/').filter(Boolean).at(-1)?.toLowerCase()
    ),
    cartUrl: loblawCartUrl,
    cartProductIds: loblawCartProductIds,
    cartItemEvidence: (root) => Boolean(root.querySelector(LOBLAW_CART_ITEM))
  });
}

export function installLoblawShoppingList(capture) {
  if (!claimRuntimeInstall('loblaw-shopping-list')) return false;
  const retailerId = location.hostname === 'www.nofrills.ca' ? 'loblaw:no-frills' : 'loblaw:superstore';
  createShoppingListRunner({ retailerId, adapter: createLoblawShoppingAdapter(capture) }).install();
  return true;
}
