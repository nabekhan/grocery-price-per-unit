import { claimRuntimeInstall } from '../../runtime/install.js';
import { createRetailerCartAdapter } from '../../runtime/retailer-cart-adapter.js';
import { createShoppingListRunner } from '../../runtime/shopping-list-runner.js';

/*
 * Walmart's old Cart Builder adapter navigated search pages, scrolled the
 * virtualized grid, clicked a rendered button, and scraped the cart. That path
 * has intentionally been removed. API operations are wired here as the
 * page-world capture gains verified query, mutation, and review capabilities.
 */
export function createWalmartShoppingAdapter(capture) {
  return createRetailerCartAdapter({
    retailerName: 'Walmart',
    searchUnavailableReason: 'Walmart search API is unavailable.',
    cartUnavailableReason: 'Walmart cart API is unavailable.',
    queryProducts: typeof capture?.queryProducts === 'function'
      ? (query, options) => capture.queryProducts(query, options)
      : null,
    addProduct: typeof capture?.addProduct === 'function'
      ? (candidate, options) => capture.addProduct(candidate?.productId, options)
      : null,
    reviewCart: typeof capture?.readCart === 'function'
      ? (candidates) => capture.readCart(
        candidates.map((candidate) => candidate?.productId).filter(Boolean)
      )
      : null
  });
}

export function installWalmartShoppingList(capture) {
  if (!claimRuntimeInstall('walmart-shopping-list')) return false;
  createShoppingListRunner({
    retailerId: 'walmart',
    adapter: createWalmartShoppingAdapter(capture)
  }).install();
  return true;
}
