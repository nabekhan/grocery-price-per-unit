# Test record

## Unified four-store extension (2026-08-02)

The current `2.0.5` extension supports Walmart Canada, Real Canadian Superstore, No Frills, and Save-On-Foods. `npm run check` covers the shared parser/sorter, retailer capture adapters, Loblaw fixtures, Walmart ordering and append handling, and Save-On-Foods API fixtures including paginated capture. The Walmart fixture suite does not claim coupon-price support: coupon and multi-buy badge amounts are intentionally excluded from the certain price used for annotations and sorting.

The live evidence below predates the unified Walmart and Save-On-Foods release unless a row explicitly says otherwise. It establishes the recorded Loblaw behavior; deterministic fixture coverage for Walmart and Save-On-Foods is not presented as live-store validation.

## Historical Loblaw API-first build (2026-08-01)

The `1.2.0` build superseded the DOM-derived product-data behavior described in the historical record below. Its final offline run passed 42 unit/DOM tests and ten Playwright WebKit extension scenarios. Coverage includes embedded Next.js capture on Superstore and No Frills, consecutive-search response capture, merging later API pages, allowlisted bridge fields, malformed product rejection, exact product-ID reconciliation, API precedence over changed card text, variable-weight safeguards, response-driven dynamic append, sorting every scoped API result, restoration, responsive UI, waiting for the retailer toolbar without a floating fallback, and multi-grid handling.

The signed Safari build passed live No Frills milk with 51 loaded cards, 51 API matches, zero missing records, and monotonic ordering inside all represented unit groups. A normal soft search change to eggs retained one No Frills control and produced 12/12 API matches with count sorting. The final RCSS rice regression produced 12/12 API matches with mass sorting.

The redesigned selector was rendered open at 390×844, 768×900, and 1440×900 in WebKit. Each run asserts that the button and menu remain inside the viewport and that all 11 choices render. A final signed-Safari milk audit lazy-loaded 54 cards: all 54 matched API records, all were annotated and assigned an order, and every unit group was independently monotonic. Visual captures are local-only and intentionally excluded from Git.

Tested 2026-07-31 on macOS with Playwright 1.54-compatible WebKit 26.0 and `en-CA`. Committed fixtures now use UTC so the public configuration does not encode a tester's region. Desktop emulation used 1280×720; the fixture mobile test used 390×844. The compatibility userscript mentioned in older records is no longer shipped; the Safari WebExtension is primary.

## Automated results

- Current deterministic unit coverage includes parser/conversion, sorting, DOM extraction, API capture, and restoration. The retired search-word relevance tests belonged to a removed heuristic and are preserved only in the historical worklog.
- WebKit fixtures cover deterministic sorting, reversal, restoration, incremental API-page merging, duplicate prevention, total-price fallback, full scoped-result sorting, phone/tablet/desktop viewport containment, complete-main SPA replacement, silent scroll population, and sorting/restoring across multiple Loblaw grid chunks.
- `npm run test:live`: 5 live WebKit scenarios passed when last run as the full matrix plus the separately run navigation cycle. Screenshots and traces are retained only in ignored local artifact directories.

## Live matrix

| Banner / anonymous store | Search | Dimension | Outcome |
|---|---|---:|---|
| Superstore / anonymous auto-selected store | milk | volume | Pass: injected once, retailer values normalized to $/L, compatible values monotonic, incompatible/unknown after group, count preserved, links present, restore passed. |
| Superstore / anonymous auto-selected store | eggs | count | Pass: $/each group sorted with the same integrity/error checks. |
| Superstore / anonymous auto-selected store | rice | mass | Pass: $/kg group sorted with the same integrity/error checks. |
| No Frills / anonymous auto-selected store | milk | volume | Pass independently against No Frills live markup with the same assertions. |
| Superstore / anonymous auto-selected store | milk → eggs via search field | volume → count | Pass: normal scroll attempted, SPA search submitted, route/results changed, preference reapplied, and exactly one control remained. |

### Expanded representative matrix

`npm run test:live:matrix` passed 19/19 searches in one serial, low-frequency WebKit run (2.4 minutes). Every page returned HTTP 200, retained its pre-injection title count, injected one control, and produced no new page errors.

| Banner | Searches | Observed automatic basis |
|---|---|---|
| Superstore | all-purpose flour, sugar, onions, garlic, tomatoes, chicken breast, cheddar cheese, Greek yogurt | Predominantly mass; mixed results kept 1–4 incompatible products below the compatible group. |
| Superstore | olive oil, black beans, laundry detergent, shampoo | Predominantly volume; black beans and detergent retained incompatible products below. |
| Superstore | toilet paper, garbage bags, birthday candles | Count. |
| No Frills | all-purpose flour | Mass. |
| No Frills | olive oil, laundry detergent | Volume; detergent retained four incompatible products below. |
| No Frills | toilet paper | Count. |

All 19 live pages exposed some unit price, so none naturally triggered total-price fallback. A fully unitless page was therefore validated deterministically in WebKit: automatic mode selected total price, ordered `$2` before `$9`, and placed the missing-price card last. This is not presented as a live-site fallback observation.

### Hardware and home-goods probe

`npm run test:live:hardware` passed 12/12 Superstore searches in 1.4 minutes: hammer, screwdriver, extension cord, light bulbs, storage bin, frying pan, kitchen utensils, snow shovel, door mat, batteries, picture frame, and garden hose. Card counts were preserved and all inspected grid annotations came from explicit retailer unit data.

The expected unitless case did not occur. Superstore explicitly emitted `$…/1ea` for individual hardware/home products and per-each prices for multipacks such as bulbs and batteries. Automatic mode therefore correctly selected count for ten searches; broad `hammer` and sparse `picture frame` results contained enough unrelated mass products for automatic mode to select mass. For a one-item hardware product, retailer `$X/1ea` is numerically equal to its `$X` total price, but it remains explicit count-unit data and does not meet the fallback condition.

No products were added to a cart, no account was used, no CAPTCHA appeared, no consent choice was made, and no independent API requests were generated by the userscript.

### Search relevance

A live WebKit `bell pepper` search passed: every annotated product had `bell` or `pepper` as a product-name word and unrelated loaded cards were excluded. Unit tests additionally cover eggs/egg, onions/onion, tomatoes/tomato, stop words, and category pages without search terms.

## Untested

- iPhone and iPad Safari.
- A second region/store per banner; each banner was tested only in one automatically selected anonymous context.
- Category and deals grids, native sort changes, an explicit load-more button, member pricing, after-limit pricing, deposits/taxes, and a live marketing-equivalent package.
- Live dynamically appended cards were attempted through ordinary scrolling; deterministic append/resort behavior was conclusively validated in WebKit fixtures, but a live append event was not separately recorded as having occurred.
- Butter, coffee, cereal, pasta, apples, and paper towels were not included in the expanded run; closely related conversion types were covered, but those exact live searches remain untested.
- No genuinely unitless live Loblaw product grid has yet been found. Total fallback remains conclusively fixture-tested rather than live-triggered.

## Signed Safari multi-department scrolling audit

Version `0.6.3` build `4` was installed with the Personal Team and inspected in production Safari on 2026-07-31. The store identifier and region are intentionally omitted. The page was account-aware, but the test did not open account/cart data, change the store, or add/remove products. Each query was inspected at the top and after scrolling; visual captures were kept local rather than committed.

| Search | Loaded results | Automatic result | Visual outcome |
|---|---:|---|---|
| milk | 36 | 32 relevant; volume predominant | Pass after fix: one global sequence across the former 18+18 grids; inspected values rose from $3.70 through $5.60/L before incompatible mass. |
| apples | 36 | 29 mass, 3 incompatible, 4 name-excluded | Pass: inspected mass values rose from $7.40 through $21.20/kg before count products. |
| toothpaste | 36 | 33 volume, 1 incompatible, 2 excluded | Pass: inspected values rose from $31.90 through $83.90/L across the former grid boundary. |
| laundry detergent | 36 | 31 volume, 5 incompatible | Pass: inspected values rose from $4.70 through $10.10/L; load descriptions did not override explicit retailer volume prices. |
| toilet paper | 36 | 23 count, 13 excluded | Structurally pass; retailer `each` semantics varied between roll and package, so value comparability is limited and documented. |
| hammer | 36 | 0 relevant; total-price fallback had no eligible matches | Negative case passed: the storefront returned unrelated cleaners and the relevance guard refused to rank them as hammers. |
| frying pan | 36 | 12 count, 24 excluded | Pass: matching frying/pan names were ranked; the later skillet/wok/cookware cards remained unannotated in website order as required. |

The first milk scroll exposed the old largest-grid assumption: only one 18-card chunk was sorted and later values were non-monotonic. That evidence was rejected, the implementation was changed to aggregate/consolidate semantic result grids, and milk plus the remaining matrix were rerun on the signed replacement build.
