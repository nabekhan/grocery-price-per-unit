/*!
 * Save-On-Foods search results use fulfillment/store-scoped `results` routes,
 * for example `/sm/pickup/rsid/6647/results`. A non-empty `q` also preserves
 * legacy and fixture search URLs.
 */

const RESULTS_ROUTE = /^\/sm\/(?:pickup|delivery)\/rsid\/[^/]+\/results\/?$/i;

export function isSaveOnSearchPage(url) {
  if (!(url instanceof URL)) return false;
  return RESULTS_ROUTE.test(url.pathname) || Boolean(url.searchParams.get('q')?.trim());
}
