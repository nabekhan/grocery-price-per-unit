# Known limitations

- Only currently loaded products are sorted. Normal scrolling is observed and new cards are rescanned, but the extension does not fetch catalogue pages or claim catalogue-wide order.
- Superstore and No Frills use embedded Next.js state plus observed PC Express search responses; Walmart and Save-On-Foods use their own observed storefront search responses. A retailer schema or endpoint change safely leaves unmatched cards intact and unannotated until its adapter is updated.
- Card reconciliation requires each storefront to retain a stable API product ID on its rendered card or product link. The extension does not fall back to rendered names, prices, package sizes, promotions, or unit prices.
- RCSS can return related or broad results for a search. All cards in the current scoped API result are sorted; the extension does not apply its own name-based relevance filter.
- Total-price fallback activates only when no loaded card has a usable unit price. It compares basket prices rather than value and is labelled accordingly.
- Category, deal/promotion, native-sort-change, and explicit load-more layouts were not separately live-validated in the existing evidence.
- Conditional promotions, approximate packages, and fluid ounces without a stated US/Imperial basis can remain unknown.
- Walmart `$X coupon` and `N for $X` badges are detected for lifecycle rescanning but are not subtracted from unit prices or used for sorting. Unlike the inherited upstream implementation, this extension does not assume coupon eligibility, redemption, offer quantity, limits, or coupon/multi-buy stacking; it ranks Walmart's explicit API unit price or a certain current API package price.
- Length, area, doses, and marketing-equivalent counts are unsupported.
- “Each” is meaningful only where an item has a reasonably consistent interpretation; deterministic parsing cannot infer shopper intent. Live toilet-paper results used retailer `each` inconsistently for a roll versus a complete package, so those explicit values remain labelled retailer-provided but are not guaranteed cross-product equivalents.
- Store assortment, pricing, and labels vary by location. Existing anonymous automation covered only one automatically selected context per tested Loblaw banner; identifying store and region details are not retained in public documentation.
- Storefront redesigns can break grid inference despite semantic hooks and safe failure behavior.
- Playwright WebKit is not production Safari. The signed Safari extension requires explicit enablement and host access. iOS/iPadOS Safari remains unverified.
- The retailer's privacy layer may block interaction with the in-page control until the visitor makes their own consent choice.
- Shoppers Drug Mart is intentionally unsupported. Its live food-category API tiles exposed prices but no package quantity fields, so comparable unit prices cannot be calculated without falling back to rendered text or separate product-detail requests.
