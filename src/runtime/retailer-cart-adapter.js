/*!
 * Shared API-only boundary for retailer cart adapters.
 *
 * Cart Builder deliberately does not navigate retailer search pages, scroll a
 * virtualized grid, click a rendered Add button, or inspect a rendered cart.
 * Those fallbacks were slow, loaded unnecessary media, and could act on stale
 * SPA markup. Retailer plugins instead provide three narrow operations:
 *
 *   queryProducts(query)  -> verified products for the selected store
 *   addProduct(candidate) -> add the exact approved product
 *   reviewCart(items)     -> verify those exact product IDs in the cart
 *
 * Every operation is optional while a retailer plugin is being developed.
 * The shared runner treats a missing or unverified operation as unavailable
 * and stays on the current page; it never falls back to browser automation.
 */

const normalizedText = (value) => String(value || '').trim().normalize('NFKC')
  .replace(/\s+/g, ' ').toLowerCase();

function visibleElement(element) {
  if (!(element instanceof Element) || element.hidden) return false;
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden'
    && Number(style.opacity || 1) !== 0 && element.getClientRects().length > 0;
}

/*
 * API calls can still be blocked by a retailer's human-verification or store
 * picker dialog. Detect only those explicit blockers; cookie banners are left
 * to the user's content blocker and never become Cart Builder state.
 */
function retailerBlockingReason(retailerName) {
  const selectors = [
    'iframe[src*="captcha" i]', '[id*="captcha" i]', '[class*="captcha" i]',
    '[role="dialog"]', '[aria-modal="true"]'
  ];
  for (const element of document.querySelectorAll(selectors.join(','))) {
    if (!visibleElement(element)) continue;
    const text = normalizedText(element.getAttribute('title') || element.textContent);
    if (/captcha|verify (?:you are|that you are|your identity)|robot|human verification|access denied/.test(text)) {
      return `${retailerName} needs human verification. Complete it in the page, then retry.`;
    }
    if (/select (?:a )?store|choose (?:a )?(?:store|location)/.test(text)) {
      return `Choose a ${retailerName} store or location, then retry.`;
    }
  }
  return null;
}

export function createRetailerCartAdapter(config) {
  if (!config || typeof config.retailerName !== 'string' || !config.retailerName.trim()) {
    throw new TypeError('Retailer cart adapter requires a retailer name');
  }

  return Object.freeze({
    retailerName: config.retailerName,
    blockingReason: () => config.blockingReason?.()
      || retailerBlockingReason(config.retailerName),
    searchUnavailableReason: config.searchUnavailableReason,
    cartUnavailableReason: config.cartUnavailableReason,

    async queryProducts(query, options) {
      if (typeof config.queryProducts !== 'function') return null;
      try { return await config.queryProducts(query, options); } catch { return null; }
    },

    async directAddProduct(candidate, options) {
      if (typeof config.addProduct !== 'function') return null;
      try { return await config.addProduct(candidate, options); } catch { return null; }
    },

    async directReviewCart(candidates = []) {
      if (typeof config.reviewCart !== 'function') return null;
      try { return await config.reviewCart(candidates); } catch { return null; }
    }
  });
}
