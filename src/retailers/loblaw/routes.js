/*!
 * Loblaw storefront route selector. The terminal `search` segment covers both
 * `/search` and locale-prefixed routes such as `/en/search`. A non-empty
 * `search-bar` parameter also identifies fixture/legacy search routes without
 * accidentally enabling category pages.
 */

export function isLoblawSearchPage(url) {
  if (!(url instanceof URL)) return false;
  const terminalSegment = url.pathname.split('/').filter(Boolean).at(-1)?.toLowerCase();
  return terminalSegment === 'search' || Boolean(url.searchParams.get('search-bar')?.trim());
}
