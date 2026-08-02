# Grocery Price Per Unit

A single API-first Safari WebExtension for Walmart Canada, Real Canadian Superstore, No Frills, and Save-On-Foods. It compares mass (`$/kg`), volume (`$/L`), and count (`$/each`) without mixing dimensions.

Product facts are API-first. Small main-world adapters observe each storefront's embedded state and own search responses, then pass only bounded product IDs, names, prices, and package sizing to isolated content scripts. The DOM is used to match stable IDs to existing cards, place controls, and reorder retailer-owned nodes.

## Safari installation

```sh
npm install
npm run safari:generate
SAFARI_DEVELOPMENT_TEAM=YOUR_PERSONAL_TEAM_ID npm run safari:build
npm run safari:install
open "safari/Grocery Price Per Unit/Grocery Price Per Unit.xcodeproj"
```

The install command verifies the signed build, moves any existing app bundle to `~/.Trash/Grocery-extension-install-backups`, installs into an empty `/Applications` path, and verifies the installed signature before reopening Safari. This avoids stale resources invalidating the app when files are removed between builds.

Alternatively, in Xcode select **Grocery Price Per Unit (macOS)** and your Personal Team for both macOS targets, then Run. Enable **Grocery Price Per Unit** under **Safari → Settings → Extensions** and grant access to the supported storefronts.

The generated Xcode wrapper includes the converter's iOS host targets where supported. The unpacked cross-browser WebExtension is generated in `dist/extension/`.

Click the extension's toolbar icon to choose the shared default sorting mode or open any of the four supported stores. **Automatic** detects the predominant comparable unit, places that group first, sorts every remaining compatible unit group in the same direction, and leaves unknown products last. The in-page **Unit price** menu can override the setting for the current page.

## Architecture

Retailer adapters live under `src/retailers/` and only handle page-owned API capture plus stable card/grid IDs. RCSS and No Frills intentionally share `src/retailers/loblaw/` because both banners use the same PC Express data and grid contract; Walmart and Save-On-Foods have separate sibling adapters. All retailers import the same ordering engine, floating control, status output, and card badge. The capture scripts observe storefront state or responses; they do not issue grocery search requests or read credentials.

| Storefront | Product-data source | Current status |
|---|---|---|
| Walmart Canada | Walmart's own observed search responses | Supported; API-first adapter and deterministic WebKit fixtures |
| Real Canadian Superstore | Embedded Next.js state and observed PC Express search responses | Supported and live-tested in Safari/WebKit |
| No Frills | Embedded Next.js state and observed PC Express search responses | Supported and independently live-tested in Safari/WebKit |
| Save-On-Foods | Observed Storefront Gateway search responses | Supported; initial and paginated-response capture is fixture-tested |

## Behavior

The selector provides automatic predominant-dimension, mass, volume, count, and total-price modes. Automatic mode selects the predominant compatible dimension. When an entire loaded result set has no usable unit prices, it falls back to current displayed total price. It never creates a ranking across unlike dimensions.

Every loaded product with a stable card/API ID participates. The extension does not second-guess results with a product-name heuristic, so related results at the end of a page are sorted too.

Green annotations normalize an explicit unit price supplied by the retailer API. Blue annotations are calculated from an API current price and unambiguous API package quantity. A card without an exact current-page API record is left unannotated; rendered card price or package text is never used as replacement product data.

### Walmart coupons and multi-buy offers

The Walmart adapter retains coupon and multi-buy badge recognition inherited from [huntertran/walmart-price-compare](https://github.com/huntertran/walmart-price-compare). That upstream extension shows additional hypothetical unit prices for a `$X coupon`, an `N for $X` offer, and their combination.

This unified extension does **not** subtract those conditional discounts from the displayed or sortable value. Walmart annotations and ranking use the explicit Walmart API unit price when available, otherwise the current API package price and an unambiguous package quantity. Coupon and multi-buy text remains part of the card-change signature so a changed badge triggers a rescan, but it cannot make a conditional price look like the certain single-item price. Coupon redemption rules, eligibility, limits, and stacking are not inferred.

The sorter changes only CSS `order`, preserving retailer card nodes, links, controls, React bindings, and DOM order. **Restore website order** removes those properties. A debounced observer incorporates lazily appended and rerendered cards without making network requests.

The in-page control is one universal fixed-position component. It does not clone or depend on a retailer toolbar, so site-specific header redesigns do not affect it.

The extension observes the stable document body with a debounced callback because Loblaw replaces its complete main element during client-side navigation. This allows the control to reappear after search and route changes without duplicating it.

## Privacy and permissions

The extension runs only on the four named storefront domains. It observes product data already loaded by each storefront and makes no independent grocery requests. It contains no AI integration, analytics, credentials, or remote dependencies. It does not read account, address, cart, cookies, or browsing history; add items to a cart; or alter store selection. Raw responses never cross the main-world bridge or enter extension storage.

The manifest requests only the supported host patterns plus synchronized extension storage. It does not request tabs, active-tab, cookies, web-request, scripting, or background-service permissions.

## Development and testing

```sh
npm run build          # unpacked API-first WebExtension
npm test               # capture, parser, conversion, sorting, and card-ID tests
npm run lint
npm run test:e2e       # deterministic Playwright WebKit fixture tests
npm run check
npm run test:live      # low-frequency live WebKit tests
```

Playwright WebKit is a secondary compatibility target, not production Safari. Follow [EVALUATION.md](EVALUATION.md) for the live Safari, responsive-viewport, dynamic-grid, and visual-order procedure. Do not rely on counters alone: inspect actual top and scrolled rows for monotonic order, semantic unit errors, hidden-card gaps, duplicates, and lazy-load failures.

See [TESTING.md](TESTING.md) and [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) for recorded evidence and explicit boundaries.

## Credit

- Walmart foundation: [huntertran/walmart-price-compare](https://github.com/huntertran/walmart-price-compare)
- API Guidance: [snacsnoc/grocery-app](https://github.com/snacsnoc/grocery-app/tree/main)

## License

GPL-3.0-only. The Walmart implementation is derived from the GPL-3.0
`huntertran/walmart-price-compare` project and has been substantially modified.
See [LICENSE](LICENSE) and [NOTICE](NOTICE).
