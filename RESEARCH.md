# Research and current-site observations

Inspected 2026-07-31 unless otherwise stated. The Walmart adapter was inherited and adapted from the GPL-3.0 [Walmart Price Per Unit](https://github.com/huntertran/walmart-price-compare) project; the Loblaw and Save-On-Foods adapters and shared dimension-aware sorter were developed for this repository. Historical “no code copied” decisions below apply to their individual rows, not to the Walmart adapter.

## 2026-08-01 API-first revision

Live Safari inspection of `milk` and `eggs` searches found that RCSS embeds the complete result model in `#__NEXT_DATA__.props.pageProps.initialSearchData`. The `milk` payload contained 50 `productTiles` while only 20 title nodes were initially rendered. Tiles expose a stable `productId`, title, `pricing`, `packageSizing`, and product link; an observed example used `1.89 l, $0.40/100ml`. Search submission currently performs a full Next.js navigation. The extension therefore reads the embedded payload at `document_start` and also observes the storefront's own PC Express `/products/search` fetch/XHR responses for future in-page navigation. It does not reproduce the historical `grocery-app` request, add headers, copy credentials, or make an independent request.

This supersedes the earlier DOM-only data-source decision below. The earlier rejection remains valid specifically for independent API requests; passive, sanitized capture of data RCSS already loaded avoids the store/session and duplicate-traffic problems.

## Prior art

| Project | Finding | Licence/reuse decision |
|---|---|---|
| [Walmart Price Per Unit](https://github.com/huntertran/walmart-price-compare) | The Walmart-specific foundation recognizes `N for $X` badges and `$X coupon` banners. Upstream displays regular, multi-buy, coupon-adjusted, and combined coupon-plus-multi-buy unit prices. | GPL-3.0; the Walmart adapter was inherited and then changed to use passively captured Walmart API product facts and the shared dimension-aware sorter. Conditional coupon and multi-buy amounts are no longer applied to the displayed or sortable price; their badge text is retained only as a rescan signal. |
| [Userscripts for Safari](https://github.com/quoid/userscripts) | Current documentation supports repeated `@match`, `document-idle`, and `auto`/`content`/`page` injection. It supports macOS and iOS/iPadOS; content mode supplies GM APIs and is suggested when CSP causes trouble. | GPL-3.0 app; documentation informed metadata only. Chose `content`, no GM APIs, and no `@require`. |
| [Supermarket Unit Value](https://github.com/mcsdevv/supermarket-unit-value) | 2026 MIT Chrome MV3 extension for Tesco, Sainsbury's, and Waitrose. Centralizes conversions, inserts a sort option, observes appended cards, and acknowledges loaded-only sorting. Current UK selectors do not match Loblaw, its extension architecture is unsuitable for Safari, and its unit-group ordering includes unlike count concepts. | MIT, but no code copied. Reused only general ideas: central conversion, debounced observation, loaded-only disclosure. |
| [chips-price](https://github.com/samuel-walker/chips-price) | 2018 Superstore experiment. AJAX/iframe scraping failed, so it used manually downloaded HTML; a Python script multiplied `x` packages and calculated price per 100 g. Its old `plp` endpoints/classes do not match the 2026 storefront. | MIT; no code copied. Multi-pack concept independently implemented with broader tests. |
| [grocery-app HACKING.md](https://github.com/snacsnoc/grocery-app/blob/main/HACKING.md) | Historical notes identify shared PC Express APIs/banner selectors and warn that store context matters. | Rejected as a recipe for independent extension requests. Retained as endpoint context; live page-owned payloads are now captured passively instead. No code copied. |
| [Greasy Fork search: Carrefour per-unit sorter](https://greasyfork.org/en/scripts?language=all&locale_override=9&page=92&sort=name) | Confirms other retailer-specific DOM sorters exist. Search did not reveal a maintained Loblaw/Superstore userscript. | No code inspected or reused. |
| [Super Tracker](https://chromewebstore.google.com/detail/super-tracker/infpnaegeildplnpjgldbkikibdmpmhn) | Chrome extension for Superstore sale selection and discount-percentage sorting, including PC Optimum and limit-price calculations. It does not advertise dimension-aware unit-price sorting; discoverable source and a reusable licence were unavailable. | No code copied. Its automatic multi-page deal workflow is outside this project's loaded-results scope. Inspected 2026-07-31. |
| [PriceGoose supported PC Express pages](https://pricegoose.ca/support/supported-pc-express-pages/) | Supports Superstore live carts and individual past orders, while product search/category pages are explicitly unsupported. | No code copied; it solves a different workflow. Inspected 2026-07-31. |
| [Actually Useful Amazon Search](https://greasyfork.org/en/scripts/572045-actually-useful-amazon-search) | A current unit-price userscript, but applies to Amazon and declares tracking plus an all-rights-reserved licence. | Rejected: wrong platform, tracking conflicts with privacy requirement, and code is not reusable. |

The expanded test list was based primarily on the [BCCDC Food Skills for Families sample shopping list](https://www.bccdc.ca/Our-Services-Site/Documents/Food%20Skills%20for%20Families/Session%20Activities%20and%20Resources/Food%20Sense_Session%20Shopping%20Lists_January%202022%20Edition.pdf), which spans produce, dairy, proteins, oils, beans, and baking ingredients. Household cases were added to exercise volume and count semantics beyond food. As a cross-check on consumer relevance, Canadian ordering data identifies chips, pop, milk, and bread among frequently ordered items ([Canadian Grocer](https://canadiangrocer.com/chips-top-skips-list-most-ordered-grocery-items-2024)).

## Live storefront findings

Anonymous Playwright WebKit loads redirected `/search?search-bar=…` to localized `/en/search` URLs with a store and fresh cart identifier. Those identifiers were neither copied into fixtures nor committed.

Both banners exposed the same semantic hooks in tested search grids:

- `[data-testid="product-title"]`
- `[data-testid="product-package-size"]`, combining package and explicit unit price (for example `4 l, $0.16/100ml`)
- `[data-testid="price-product-tile"]`, with regular/sale descendants
- ordinary product links and add-to-cart buttons with accessible names
- `[data-testid="listing-page-container"]` and repeated `[data-testid="product-grid-component"]` result chunks

Generated Chakra/CSS classes differed between cards and were rejected. Product cards had no single stable card test id. Live Safari scrolling showed that Loblaw renders successive batches as separate sibling product grids (18 + 18 cards in the tested pages), while unrelated carousels can contain the same title hook. The adapter now aggregates only semantic product grids inside the listing-page container. While sorting, it moves the existing card nodes into the first result grid so CSS `order` can provide one global loaded-results sequence; node identity and delegated handlers are preserved. Original parent/index locations are retained and Website order moves every card back. A debounced body observer and passive captured scroll listener repeat this reconciliation after SPA replacement or lazy population.

Both banners were tested in anonymous, automatically selected store contexts. Store names, identifiers, cart identifiers, and region details are intentionally omitted from this public record; no location dialog or account was used.

Explicit unit prices encountered live included per 100 g and per 100 mL. The site's normal first-visit privacy layer intercepted pointer interaction with the floating panel until a consent choice; automated tests did not make that choice and invoked Restore through DOM dispatch. Existing storefront console/page errors were baselined before injection so only new userscript errors were assessed.

Historical API state was rejected as a data source after a fresh comparison with [snacsnoc/grocery-app](https://github.com/snacsnoc/grocery-app): it introduces store/session coupling, independent traffic, private API-key/header assumptions, short-lived request schemas, and content/page-world complexity. It could also expose account-aware page context to a request the extension does not need. The current displayed semantic data is sufficient for the validated 36-card scrolling cases.
