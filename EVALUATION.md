# Evaluation Method

Use the same evidence standard for every supported retailer: inspect the page a shopper actually sees, not only internal counters or DOM order.

## Live Safari procedure

1. Build and install the current signed Safari extension, enable access for the storefront under test, and reload its tab.
2. Search for a representative product and wait for the grid and **Unit price sort** control.
3. Select a sorting mode through the real control.
4. Read visible product names, total prices, package/unit labels, and annotations in the first row.
5. Verify monotonic values within the selected compatible dimension. Never treat mass, volume, and count as one sequence.
6. Scroll through several later rows, pause for lazy rendering, and inspect again.
7. Look for blank cells, gaps, duplicates, hidden sponsored cards, unrelated cards between sorted products, stale annotations, and newly loaded cards that were not re-sorted.
8. Test ascending, descending, automatic, a dimension-specific mode, total-price mode, and restoration.
9. Confirm product links and normal controls still work; do not add anything to a real cart.

Check semantics, not just arithmetic. Specifications, model numbers, dosage strengths, and marketing equivalencies are not necessarily purchased quantities. Prefer the retailer's explicit current unit price. Mark uncertain promotions or packages unknown. On a completely unitless page, verify rendered total prices are monotonic.

## Search matrix

Include mass, volume, count, variable-weight, multipack, sale, and unitless cases. Useful searches include milk, eggs, butter, cheese, yogurt, coffee, cereal, pasta, rice, cooking oil, chicken, apples, bell peppers, laundry detergent, toilet paper, and at least one non-grocery or hardware query.

Only matching search names should be annotated or sorted. For `bell pepper`, verify every reviewed name contains `bell` or `pepper`; unrelated recommendations stay below the matching group.

## Safari viewport testing

Change the page viewport with **Develop → Enter Responsive Design Mode**, not by resizing Safari's window. At approximately 400 CSS pixels wide, confirm the panel stays inside the viewport, does not cover essential controls, accepts keyboard focus, and still sorts and restores. Scroll the emulated page and inspect dynamically rendered rows. Repeat at tablet and desktop widths where practical.

## Playwright WebKit

Run `npm run test:e2e` against sanitized fixtures to verify injection, sorting, reverse, restoration, dynamic append, duplicate prevention, and a 390-pixel viewport. Use live WebKit only at low frequency. If the storefront challenges automation, do not bypass it; record the limitation and use live Safari plus fixtures. Never report fixture testing as live-site validation.

## Completion standard

A change is ready only after syntax/lint/tests pass, the signed Safari build is reloaded, an affected live search is visually inspected at the top and after scrolling, no cards are lost or duplicated, annotations are semantically correct, unknown cards use the documented fallback, and narrow viewport behavior is checked for UI changes.
