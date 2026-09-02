/*!
 * Walmart Canada route selector. Search currently lives at `/en/search`; the
 * terminal-segment check remains locale-agnostic. A query parameter by itself
 * is not enough: product/category URLs can also carry `q` and must stay dormant.
 */

export function isWalmartSearchPage(url) {
  if (!(url instanceof URL)) return false;
  const terminalSegment = url.pathname.split('/').filter(Boolean).at(-1)?.toLowerCase();
  return terminalSegment === 'search';
}
