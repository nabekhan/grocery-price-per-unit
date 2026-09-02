# Grocery Price Per Unit

A readable Safari userscript for Walmart Canada, Real Canadian Superstore,
No Frills, and Save-On-Foods. It shows and sorts comparable grocery prices by
weight (`$/kg`), volume (`$/L`), count (`$/each`), or current total price.

The script passively observes product data each storefront already loads. It
makes no catalogue requests, has no remote dependencies or analytics, and does
not interact with consent dialogs or CAPTCHAs.

## Install with Nix

Install **Userscripts** for Safari, enable the extension, and give it access to
the four supported storefronts. Then run:

```sh
npm ci
npm run userscript:install -- \
  "/absolute/path/from/Userscripts/Grocery Price Per Unit.user.js"
```

The installer requires a released, hash-recorded build. It preserves the old
file as a timestamped `.backup-*`, commits atomically, and verifies the installed
bytes. Fully quit and reopen Safari after the first installation.

## Use

Open a supported search-results page. The **Unit price** panel offers:

- Website order
- Automatic
- By weight
- By volume
- By count
- Total price

Use the adjacent arrow to reverse direction. **Website order** restores the
retailer's ordering and releases all userscript-owned presentation changes.
Preferences are stored separately on each storefront origin.

Mass, volume, and count are never compared with one another. Pending or
unmatched API data preserves website order. Sponsored/ad hiding is deliberately
narrow and retailer-specific; ordinary content and ambiguous matches stay
visible.

## Develop

```sh
npm run build
npm run check
npm run visual:audit
npm run userscript:candidate:verify
```

The visual audit writes a browsable responsive screenshot report to
`artifacts/screenshots/visual-audit-report.html`.
