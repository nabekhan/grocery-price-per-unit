import { claimRuntimeInstall } from '../../runtime/install.js';
import { createRetailerCartAdapter } from '../../runtime/retailer-cart-adapter.js';
import { createShoppingListRunner } from '../../runtime/shopping-list-runner.js';
import { modelForApiProduct } from './site.js';

/*
 * Superstore and No Frills are two storefronts over the same PC Express API.
 * Their Cart Builder adapter therefore contains no routes or DOM selectors:
 * search, Add, and review all stay inside the page-world capture capability.
 */
export function createLoblawShoppingAdapter(capture) {
  const retailerName = location.hostname === 'www.nofrills.ca' ? 'No Frills' : 'Superstore';
  return createRetailerCartAdapter({
    retailerName,
    searchUnavailableReason: `${retailerName} search API is unavailable.`,
    cartUnavailableReason: `${retailerName} cart API is unavailable.`,

    // The capture capability transports only bounded raw retailer facts. Run
    // every result through the shared Loblaw product parser before ranking it.
    queryProducts: typeof capture?.queryProducts === 'function'
      ? async (query) => {
        const response = await capture.queryProducts(query);
        if (response?.status !== 'complete' || !Array.isArray(response.products)) return response;
        return {
          status: 'complete',
          products: response.products.map((product) => {
            const model = modelForApiProduct(product);
            return model ? { ...model, matched: true, addable: true } : null;
          }).filter(Boolean)
        };
      }
      : null,

    // Add and review both target the exact active cart/store validated by the
    // page-world capability. A null result fails closed in the shared runner.
    addProduct: typeof capture?.addProduct === 'function'
      ? async (candidate) => capture.addProduct(candidate?.productId)
      : null,
    reviewCart: typeof capture?.readCart === 'function'
      ? async (candidates) => capture.readCart(
        candidates.map((candidate) => candidate?.productId).filter(Boolean)
      )
      : null
  });
}

export function installLoblawShoppingList(capture) {
  if (!claimRuntimeInstall('loblaw-shopping-list')) return false;
  const retailerId = location.hostname === 'www.nofrills.ca' ? 'loblaw:no-frills' : 'loblaw:superstore';
  createShoppingListRunner({ retailerId, adapter: createLoblawShoppingAdapter(capture) }).install();
  return true;
}
