# Repository instructions

## Scope

Build and maintain a deterministic multi-store Safari WebExtension that sorts currently loaded product cards by dimension-aware unit price. The supported storefronts are Walmart Canada, Real Canadian Superstore, No Frills, and Save-On-Foods. Keep live-validation claims retailer-specific: Superstore and No Frills have inspected live evidence, while Walmart and Save-On-Foods require their own documented live cycles before being described as live-validated. The extension is primary; do not restore the removed compatibility userscript. Do not add AI or network-backed analysis.

## Conventions

- Use ES2020-compatible browser JavaScript and no Node globals in shipped code.
- Keep parsing, sorting, site adapters, UI, and lifecycle logic separate under `src/`.
- Prefer semantic attributes, product URLs, and visible labels over generated CSS classes.
- Never compare mass, volume, and count as one numeric ranking.
- Explicit retailer unit prices take precedence over calculated package prices.
- Do not add network requests, analytics, credentials, cookies, or remote runtime dependencies.
- Edit repository files with patch-based edits and preserve unrelated user work.

## Commands

- `npm run build` — bundle the unpacked WebExtension into `dist/extension/`.
- `npm run safari:generate` — generate the Safari Xcode wrapper from `dist/extension/`.
- `npm run safari:build` — compile the generated Safari app and extension.
- `npm test` — run unit and DOM fixture tests.
- `npm run lint` — run static checks.
- `npm run test:e2e` — run deterministic WebKit fixture browser tests.
- `npm run test:live` — run low-frequency live WebKit checks (site access dependent).
- `npm run check` — build, lint, and run non-live tests.

## Browser testing

- Playwright WebKit is the automated compatibility target; it is not production Safari.
- Inject the built artifact after DOM content load to approximate `@run-at document-idle`.
- On live pages, record URL/query, date, viewport, selected store/region if visible, console errors, card counts before/after, monotonicity, duplicate controls, navigation, appended cards, and restore behavior.
- Keep traffic low. Never log in, bypass bot protection, add to cart, or retain cookies/tokens.
- Save only sanitized fixtures and artifacts.

## Completion criteria

- A valid unpacked WebExtension exists in `dist/extension/` and the generated Safari project compiles.
- Parser/conversion, stable sorting, restoration, DOM fixtures, dynamic append, and WebKit tests pass.
- At least three meaningful live cycles are attempted and documented for a retailer before declaring full live support; claims require inspected evidence.
- Mass, volume, and count live scenarios, SPA navigation, append handling, restore, no loss/duplication, duplicate-control prevention, and console cleanliness are verified retailer by retailer before declaring full live support.
- `README.md`, `RESEARCH.md`, `WORKLOG.md`, `TESTING.md`, and `KNOWN_LIMITATIONS.md` accurately distinguish tested, failed, and untested behavior.
