# Worklog

## 2026-08-02 — unified documentation and Walmart lineage

- Updated the repository overview for the current four-store `2.0.5` extension and distinguished live Loblaw evidence from deterministic Walmart and Save-On-Foods fixture coverage.
- Credited `huntertran/walmart-price-compare` as the inherited Walmart foundation and `snacsnoc/grocery-app` for API guidance.
- Documented the coupon divergence precisely: upstream computes hypothetical coupon, multi-buy, and combined unit prices, while this API-first extension does not apply conditional offer amounts to annotations or sorting. Walmart badge text remains a lifecycle rescan signal only.
- Renamed the Safari wrapper, Xcode targets/scheme, bundle identifiers, contributor label, build paths, and Loblaw adapter debug prefix to **Grocery Price Per Unit**.
- Moved the shared RCSS/No Frills implementation from legacy top-level `src/main.js`, `src/api/`, and `src/sites/` paths into `src/retailers/loblaw/`, alongside the Walmart and Save-On-Foods adapters. The two Loblaw banners share one adapter because their tested API and grid contracts are the same.
- Standardized retailer entry-point naming on `content.js` plus `api-capture-main.js`; Walmart keeps its additional `sort-main.js` because its inherited card annotator and shared-ordering integration are separate scripts in the manifest.
- Removed the unused lexical relevance module and tests after confirming no shipped entry point imports them. Production has treated each retailer's scoped API result as authoritative since `1.1.2`; historical relevance results remain below as superseded evidence.
- Final verification passed 41 current unit/DOM tests and 17 deterministic Playwright WebKit scenarios. The renamed Xcode project compiled and signed version `2.0.5` build `25` with the Personal Team.
- Replaced the installed `/Applications/Grocery Price Per Unit.app` through the recoverable installer flow. The host and extension use a project-generic bundle identifier; the prior installed bundle was moved to the current user's Trash backup folder and the new extension is the registered Safari copy.
- Removed exact live store names, store IDs, region names, personal filesystem paths, and the owner-derived bundle identifier from committed text/configuration. Synthetic fixtures now use an explicit fixture store ID and UTC; local ignored artifacts remain outside Git.
- Removed private-install migration branches before publication: the installer no longer detects or retires the former app bundle, saved settings are no longer translated from former mode names, and build scripts no longer clean up removed userscript/resource paths. Current-app replacement remains recoverable and signature-verified.
- Corrected the repository-wide license from MIT to GPL-3.0-only and added the upstream Walmart source/modification notice required by the inherited GPL implementation.
- Removed the generated Xcode build-product registration after installation so Safari exposes only the verified `/Applications` copy. The installer now unregisters that exact development path and explicitly registers the installed app on every update.

## 2026-08-01 — consecutive-search API capture fix

- Reproduced `apples` → `rice` through RCSS's own search field in installed Safari: cards and URL changed through a soft Next.js navigation while `#__NEXT_DATA__` remained on the prior query, leaving every new card without an API match.
- Replaced the converter-unsupported `content_scripts[].world` dependency with a web-accessible page-world capture injected by the document-start isolated script. Added RCSS's own `/_next/data/<build>/en/search.json` response to the strict capture allowlist and taught the isolated lifecycle to request the latest snapshot after its URL scope changes.
- Added a regression proving an initial embedded `milk` snapshot is replaced by a later `rice` Next.js response. The extension still issues no retailer search request of its own.

## 2026-08-01 — RCSS API-first extension

- Rechecked the private predecessor repository and the Walmart API-capture architecture, then inspected live RCSS searches in Safari.
- Confirmed that `__NEXT_DATA__` contains the full `initialSearchData` product-tile result, including stable IDs, current/was prices, and package sizing; added a document-start main-world capture plus guarded observation of the storefront's own PC Express search fetch/XHR responses.
- Restricted the extension to Real Canadian Superstore. Product name, price, quantity, and unit price now come only from a sanitized, current-query API record. The DOM is limited to card-ID reconciliation, controls, annotations, and node ordering. Missing API matches remain intact and unannotated.
- Variable-weight tiles require an explicit API unit price; an estimated package weight and approximate total are never combined into a calculated checkout value.
- Removed the compatibility userscript release because it cannot provide the required main-world/isolated-world split. Added capture sanitization and API-precedence tests, and converted WebKit fixtures to exercise both extension scripts.
- Final offline regression passed 39 unit/DOM tests and seven Playwright WebKit extension scenarios. Version `1.0.0` build `6` compiled, signed with the Personal Team, passed strict deep signature verification, and was installed from `/Applications` after unregistering the generated build-product copy.
- Live Safari `milk` and `eggs` searches in an anonymous store context each showed one control and exact API matches for every initially rendered card. Milk lazy rendering reached 54 matched API cards, 46 relevant annotations, and zero missing-API cards; inspected top and middle volume rows were monotonic. Eggs count rows were monotonic, and Website order removed all extension-owned CSS ordering before count sorting was reapplied without losing cards or links. Screenshots are in an ignored local artifact directory.
- Safari's converter warned that the manifest `world` key is unsupported. The required embedded `__NEXT_DATA__` capture still passed in installed Safari; fetch/XHR observation remains best-effort on Safari and covered deterministically in WebKit. Current RCSS search submission uses a full navigation, so every tested page supplied fresh embedded data.
- Investigated the duplicate Walmart extension report. `pluginkit` showed one active `/Applications` copy, while Launch Services retained stale registrations for old Trash builds. Unregistered only those exact stale paths; no files were deleted. Verification now reports one Walmart Launch Services record and one active Walmart Safari extension.

## 2026-07-31 — Safari WebExtension conversion

- Researched current related extensions. Super Tracker sorts Superstore deals by discount rather than compatible unit price; PriceGoose supports carts/past orders rather than search/category grids. No reusable licensed Superstore unit-price sorter was found.
- Removed the optional AI providers, UI, prompts, validators, trials, tests, configuration paths, and cross-origin grant. Deterministic parsing and sorting remain the sole runtime path.
- Added a least-privilege Manifest V3 bundle for Real Canadian Superstore and No Frills, an original local icon, Safari converter/build scripts, generated macOS/iOS Xcode targets, installation documentation, and the visual evaluation method learned from Walmart testing.
- `npm run check` passed: 35 unit/DOM tests and four Playwright WebKit fixture scenarios. The Personal Team macOS Safari build completed successfully and passed deep strict code-signature verification.
- Replaced the inherited floating userscript panel with a companion menu cloned from Superstore's current Sort control. The extension reuses the live Chakra structure/classes for visual fidelity while owning its IDs, state, keyboard behavior, checkmarks, and CSS ordering. Visible-menu fixture testing found and fixed an initially detached popover list; the complete suite and signed build then passed again.

## 2026-07-31 — research and cycle 1

- Initialized the empty Git repository; added repository rules, Node tooling, WebKit, and project structure.
- Read current Userscripts metadata/injection documentation and inspected four required prior-art leads plus additional searches.
- First low-frequency WebKit loads of Superstore milk and eggs returned HTTP 200 and live products. Learned that semantic `data-testid` descendants are stable while card classes are generated; also found a separate sponsored carousel.
- Implemented centralized parsing/conversion, dimension-aware stable sorting, largest-semantic-grid inference, CSS-order application, accessible UI, annotations, and scoped/debounced lifecycle observation.
- Initial static run found ESLint module-level-await configuration and Vitest test-discovery issues; fixed both. Result: 31 unit/fixture assertions and two WebKit fixture scenarios passed.

## 2026-07-31 — cycle 2

- Injected the built release into live Superstore milk, eggs, and rice searches plus No Frills milk.
- First milk trace showed correct live annotations and intact controls but the harness counted a pre-existing storefront `SyntaxError` as a userscript error. Changed the harness to baseline page errors before injection and added explicit monotonic/compatible-first assertions.
- Restore initially timed out because the retailer's privacy layer intercepted pointer events. The harness now dispatches the userscript button without choosing privacy consent. This preserves the real limitation in documentation.
- Rebuilt and reran serially: all four banner/query tests passed in 48.4 seconds.

## 2026-07-31 — cycle 3

- Added a live lifecycle scenario using the storefront's normal scroll behavior and its own search input to navigate milk → eggs.
- Verified the URL/results transition, dimension change, absence of duplicate controls, status update, and no post-injection page errors. Cycle passed in 17.3 seconds.
- Independently revisited No Frills to record the anonymous store context and screenshot. Final documentation distinguishes deterministic fixture coverage from live coverage and lists all untested cases.

## 2026-07-31 — cycle 4: representative products and fallback

- Researched Canadian public-health sample grocery lists and common Canadian online orders; selected produce, proteins, dairy, pantry, cleaning, paper, personal-care, and party products.
- Added automatic total-price fallback only for grids with zero usable unit prices, plus a manual total-price mode and explicit status wording. Added unit and WebKit fixture tests proving the fallback order and missing-price placement.
- The first expanded live run exceeded the original one-minute test envelope after nine successful pages; raised only the matrix test timeout and reran serially.
- Final expanded run passed 19/19 live searches (15 Superstore, four No Frills) in 2.4 minutes. Mixed-dimension pages remained separated. Every live page had unit data, so the total-price fallback was not claimed as live-triggered.

## 2026-07-31 — cycle 5: hardware/unitless probe

- Ran 12 Superstore hardware and home-goods searches in live WebKit; all passed in 1.4 minutes with preserved card counts.
- Superstore supplied explicit per-each unit prices for the tested tools, electrical items, storage, cookware, seasonal hardware, batteries, and decor. No live total-fallback activation was observed.
- Broad `hammer` and sparse `picture frame` searches returned mixed results and selected mass automatically. Recorded this as search-result relevance behavior, not a parser failure; explicit count selection remains available.

## 2026-07-31 — optional AI stub

- Added a provider-neutral AI subsystem without changing deterministic defaults. The shipped adapter targets a user-configured HTTPS/local JSON endpoint; no key or vendor dependency is embedded.
- Added payload extraction/limits, fixed untrusted-data prompt, preview and confirmation UI, local configuration removal, one-request progress/cancellation, strict response validation, arithmetic cross-checking, review-before-apply, AI annotations, reverse/restore, and deterministic-mode return.
- Initial WebKit mock flow revealed that detached `window.fetch` fails in WebKit; bound the default fetch implementation to its global object and reran successfully.
- Replaced native `<dialog>` with an accessible overlay to avoid relying on post-Safari-14 dialog support.
- Final deterministic/AI suite: 48 unit tests and four WebKit fixture scenarios passed. No live AI endpoint was called.

## 2026-07-31 — TurboFieldfare localhost integration

- Read the then-current local model-server instructions and inspected a separate local model project. Found an existing server process, healthy endpoint, and model listing; did not rebuild or restart it.
- Confirmed browser preflight returns HTTP 405. Added a localhost-only Chat Completions adapter using Userscripts `GM.xmlHttpRequest`, local model/base defaults, health check, envelope parsing, cancellation, and tests.
- First three-product synthetic trial was structurally rejected. Embedded the exact response schema in the fixed prompt and retried.
- Second trial validated successfully. Deterministic cross-checking downgraded one model arithmetic/precedence disagreement to unranked, demonstrating safe partial rejection. No retailer or personal data was sent.

## 2026-07-31 — live examples with offline AI

- Changed reconciliation policy: high-confidence explicit retailer unit prices always replace AI values and stay ranked; only weaker disagreements become unranked.
- Initial six-product live attempt exposed repeated sponsored-card collection and then malformed model JSON. Both were safely rejected; updated the trial collector to the production largest-grid inference and made diagnostics tolerate malformed raw responses.
- Final three-product live/offline trial passed. Milk, rice, and eggs remained ranked in separate dimensions. Milk's AI `$1.61/L` was replaced by retailer `$1.60/L`; rice and eggs retained exact retailer values. No account/cart data or session-bearing URLs were submitted.

## 2026-07-31 — search-name relevance

- Added one shared lexical relevance partition for deterministic annotations/sorting and AI payload extraction. It requires at least one meaningful query word in the product name and handles common singular/plural forms.
- Nonmatching cards keep relative order below matches, have stale annotations removed, and are counted in status. Category pages without a search term remain unfiltered.
- Added three unit cases and a WebKit fixture payload test. A live `bell pepper` WebKit run confirmed every annotated and previewed product name contained `bell` or `pepper`; unrelated loaded cards were excluded.

## 2026-07-31 — Safari extension injection cache

- The signed extension was enabled and authorized for Superstore, but Safari did not inject it after replacing a build that retained version `1.0 (1)`. Evaluating the installed content bundle manually proved the menu code and live selectors were valid.
- Bumped both host app and extension to version `0.6.1` build `2`, made the Safari build script set those versions explicitly, regenerated, signed with the Personal Team, and reinstalled the app.
- Safari then loaded the extension normally. Visual inspection confirmed the Unit price menu appears beside Superstore's native Sort menu on the live milk results page.
- Final regression: lint/build passed, 35 unit/DOM tests passed, and all four WebKit fixture scenarios passed.

## 2026-07-31 — SPA reinjection and toolbar settings

- A live milk-to-toothpaste navigation exposed a missing menu even though annotations from the earlier page remained. DOM inspection showed Loblaw had replaced the complete observed `main`, leaving the MutationObserver attached to a detached tree.
- Moved the debounced observer to the stable `body` and added a WebKit regression that removes and replaces both the toolbar and complete main content. The test confirms exactly one native-style control is reinserted.
- Added a Safari toolbar popup with a persistent default sorting mode. Changes use extension-local synchronized storage and are applied to open supported pages without reloading; the deterministic userscript remains storage-free and defaults to website order.
- Found two registered copies of the same development extension (the Xcode build product and `/Applications`). Removed only the build-product registration and kept the signed installed app. This eliminated Safari choosing a stale content process.
- Installed and visually inspected version `0.6.2` build `3`. The live toothpaste page showed one native menu and 16 annotations; the toolbar popup rendered correctly. Final regression: 35 unit/DOM tests and five WebKit fixture tests passed.

## 2026-07-31 — chunked scrolling and multi-department Safari audit

- Ported the applicable Walmart scrolling principles: a stable-body observer, passive captured scroll rescans, semantic wrapper modeling, and original-location restoration. Added fixtures for silent text population on scroll and two independent result-grid chunks.
- The first live milk screenshot disproved the single-grid assumption: Loblaw had two successive 18-card grids, so CSS order produced two separate sorted sequences. Changed the adapter to aggregate semantic grids inside the listing container and consolidate existing card nodes into one grid only while sorted. Website order restores original parents and indices.
- Installed signed version `0.6.3` build `4`. Reran milk and inspected a globally monotonic scrolled sequence, then inspected apples, toothpaste, laundry detergent, toilet paper, hammer, and frying pan at top/scrolled positions. Captured validated screenshots in `artifacts/screenshots/safari-multidepartment-2026-07-31/`.
- Toilet paper exposed inconsistent retailer `each` meanings (roll versus package); recorded the semantic limitation. Hammer returned no name-matching hardware, and the relevance guard correctly ranked nothing.
- Reviewed a local checkout of [snacsnoc/grocery-app](https://github.com/snacsnoc/grocery-app). Rejected API integration because it depends on private/stale BFF headers, embedded identifiers, independent network requests, and session/store context without improving exact visible-card fidelity.
- Final automated regression before packaging: 35 unit/DOM tests and seven WebKit fixture tests passed.

## 2026-08-01 — selector polish and complete tail sorting

- Redesigned the in-page selector with a compact RCSS-green trigger, clearer two-line option descriptions, selected/hover/focus states, group separators, and a contained phone bottom sheet. Captured open-menu evidence at 390×844, 768×900, 1440×900, and in the installed Safari extension.
- Added a responsive WebKit regression that checks the trigger and menu remain inside each viewport and that all 11 options render.
- Reproduced partial lazy-page data by returning only a later API page. The capture now merges positive-offset pages within the same query/store scope while still replacing data for a new search.
- Live Safari showed that the remaining unsorted tail was caused by the old lexical name-relevance heuristic, not missing API matches. Removed that heuristic from production sorting: RCSS's scoped API response is now authoritative and every returned card participates.
- Changed dimension-aware ordering so the selected/predominant unit group remains first, while each remaining unit group is independently sorted in the same direction. Unlike units are never numerically compared; unknowns remain last.
- Installed signed version `1.1.2` build `10`. A live milk lazy-load reached 54 cards with 54 API matches, 54 annotations, finite order on every card, and monotonic ordering inside every represented unit group. Final regression: 41 unit/DOM tests and eight WebKit scenarios passed.
- Removed the legacy floating fallback after it appeared during an early SPA scan. Version `1.1.3` build `11` now waits for RCSS's native Sort toolbar and mounts only the retailer-integrated control; a ninth WebKit scenario covers delayed toolbar mounting.

## 2026-08-02 — No Frills expansion

- Confirmed in live Safari that No Frills uses the same PC Express product schema, `initialSearchData` layout, exact product IDs, package sizing, semantic grid, and native Sort menu as Superstore.
- Expanded the least-privilege manifest and same-origin Next.js observer to `www.nofrills.ca`; generalized user-facing labels to Loblaw/retailer wording and added deterministic No Frills capture and browser coverage.
- Evaluated Shoppers Drug Mart separately. Its 36 live canned-food API tiles exposed prices but zero package-sizing or other quantity fields, and none of their API titles contained a quantity. Shoppers remains intentionally unsupported rather than reading quantities from rendered cards or issuing product-detail requests.
- Installed signed version `1.2.0` build `12`. Live No Frills milk lazy-loaded 51 cards with 51 API matches and monotonic per-dimension order; milk → eggs soft navigation retained one control and produced 12/12 API matches. A final RCSS rice load also produced 12/12 API matches. Captured the No Frills eggs selector in `artifacts/screenshots/no-frills-2026-08-02/`.
