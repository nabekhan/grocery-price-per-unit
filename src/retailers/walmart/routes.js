/*!
 * Walmart Canada route selector. Search currently lives at `/en/search`; the
 * terminal-segment check remains locale-agnostic. `q` supports older and test
 * search routes while still requiring explicit search intent.
 */

export function isWalmartSearchPage(url) {
  if (!(url instanceof URL)) return false;
  const terminalSegment = url.pathname.split('/').filter(Boolean).at(-1)?.toLowerCase();
  return terminalSegment === 'search' || Boolean(url.searchParams.get('q')?.trim());
}
