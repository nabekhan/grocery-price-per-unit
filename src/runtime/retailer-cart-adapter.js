/*!
 * Shared DOM workflow for retailer cart adapters.
 *
 * Retailer modules provide route shapes, stable card identity, and a lexical
 * trusted-model reader. This module prefers a complete, current API snapshot
 * before using the bounded first-page DOM fallback,
 * card-scoped semantic controls, virtualization revalidation, Add verification,
 * blocker pauses, and cart-review lifecycle. No DOM price is ever accepted.
 */

const MAX_SCROLL_STEPS = 28;
const PRODUCT_SETTLE_MS = 650;
const ADD_VERIFY_MS = 8_000;

export const normalizeCartText = (value) => String(value || '').trim().normalize('NFKC')
  .replace(/\s+/g, ' ').toLowerCase();
const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

export function visibleCartElement(element) {
  if (!(element instanceof Element) || element.hidden) return false;
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden'
    && Number(style.opacity || 1) !== 0 && element.getClientRects().length > 0;
}

export function cartAccessibleName(element) {
  return normalizeCartText(element.getAttribute('aria-label') || element.getAttribute('title')
    || element.innerText || element.textContent);
}

export function findCardAddButton(card, { requireVisible = true } = {}) {
  if (!(card instanceof Element)) return null;
  for (const control of card.querySelectorAll('button,[role="button"]')) {
    if (control.matches(':disabled,[aria-disabled="true"]')) continue;
    if (requireVisible && !visibleCartElement(control)) continue;
    const name = cartAccessibleName(control);
    if (/^(?:add|add to cart)(?:\b|$)/i.test(name) && !/^(?:added|add-ons?)(?:\b|$)/i.test(name)) return control;
  }
  return null;
}

export function cardHasQuantityControl(card) {
  if (!(card instanceof Element)) return false;
  return [...card.querySelectorAll('button,[role="button"],input')].some((control) => {
    const name = cartAccessibleName(control);
    return /(?:increase|decrease|remove).*(?:quantity|item)|(?:quantity|item).*(?:increase|decrease|remove)/i.test(name)
      || /quantity/i.test(control.getAttribute('data-automation-id') || control.getAttribute('data-testid') || '');
  });
}

export function retailerBlockingReason(retailerName) {
  const selectors = [
    'iframe[src*="captcha" i]', '[id*="captcha" i]', '[class*="captcha" i]',
    '[role="dialog"]', '[aria-modal="true"]'
  ];
  for (const element of document.querySelectorAll(selectors.join(','))) {
    if (!visibleCartElement(element)) continue;
    const text = normalizeCartText(element.getAttribute('title') || element.textContent);
    if (/captcha|verify (?:you are|that you are|your identity)|robot|human verification|access denied/.test(text)) {
      return `${retailerName} needs human verification. Complete it in the page, then choose “I resolved it — continue”.`;
    }
    if (/select (?:a )?store|choose (?:a )?(?:store|location)/.test(text)) {
      return `A ${retailerName} store or location dialog needs your choice. Resolve it in the page, then continue.`;
    }
  }
  return null;
}

function cartCount() {
  const selectors = [
    '[data-automation-id*="cart-count" i]', '[data-testid*="cart-count" i]',
    '[aria-label*="cart" i]', 'a[href*="/cart"]'
  ];
  for (const element of document.querySelectorAll(selectors.join(','))) {
    if (!visibleCartElement(element)) continue;
    const name = cartAccessibleName(element);
    const explicitCounter = element.matches(
      '[data-automation-id*="cart-count" i],[data-testid*="cart-count" i]'
    );
    const explicitMatch = explicitCounter && /^\d{1,3}$/.test(name)
      ? name.match(/^(\d{1,3})$/) : null;
    if (explicitMatch) return Number(explicitMatch[1]);
    const itemMatch = name.match(/\b(\d{1,3})\s+(?:items?|products?)\b/i);
    if (itemMatch) return Number(itemMatch[1]);
    // A cart link often displays a currency subtotal. Never reinterpret that
    // number as a quantity just because the same accessible name says “cart”.
    if (/[$€£]\s*\d|\b\d+[.,]\d{2}\b/.test(name)) continue;
    const cartMatch = name.match(/\bcart\b\D{0,16}(\d{1,3})\b/i);
    if (cartMatch) return Number(cartMatch[1]);
  }
  return null;
}

function productUpdateOrDelay(eventName, milliseconds = PRODUCT_SETTLE_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener(eventName, finish);
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, milliseconds);
    window.addEventListener(eventName, finish, { once: true });
  });
}

export function createRetailerCartAdapter(config) {
  const required = [
    'retailerName', 'isSearchPage', 'searchQuery', 'searchUrl', 'cards', 'productIdForCard',
    'trustedState', 'trustedModel', 'isCartPage', 'cartUrl', 'cartProductIds', 'cartItemEvidence'
  ];
  if (required.some((key) => !config[key] || (key !== 'retailerName' && typeof config[key] !== 'function'))) {
    throw new TypeError('Retailer cart adapter is missing a required contract member');
  }
  const eventName = config.productUpdateEvent || 'ppu-products-updated';
  const maximumScrollSteps = Number.isSafeInteger(config.maximumScrollSteps)
    && config.maximumScrollSteps > 0 && config.maximumScrollSteps <= MAX_SCROLL_STEPS
    ? config.maximumScrollSteps : MAX_SCROLL_STEPS;
  const productSettleMs = Number.isFinite(config.productSettleMs)
    && config.productSettleMs >= 0 && config.productSettleMs <= PRODUCT_SETTLE_MS
    ? config.productSettleMs : PRODUCT_SETTLE_MS;
  const addVerifyMs = Number.isFinite(config.addVerifyMs)
    && config.addVerifyMs > 0 && config.addVerifyMs <= ADD_VERIFY_MS
    ? config.addVerifyMs : ADD_VERIFY_MS;
  const settle = (milliseconds = productSettleMs) => productUpdateOrDelay(eventName, milliseconds);
  const blockingReason = () => config.blockingReason?.() || retailerBlockingReason(config.retailerName);
  const cards = () => [...config.cards()].filter((card) => card instanceof Element);
  const cardForProduct = (productId) => cards()
    .find((card) => config.productIdForCard(card) === productId) || null;
  const trustedProduct = (card) => {
    if (!card) return null;
    const state = config.trustedState();
    if (!state?.accepted) return null;
    const model = config.trustedModel(state, card);
    const productId = config.productIdForCard(card);
    if (!model?.matched || !productId || model.productId !== productId || !model.name || !model.currentPrice) return null;
    return {
      matched: true,
      productId,
      name: model.name,
      currentPrice: model.currentPrice,
      normalizedUnitPrice: model.normalizedUnitPrice,
      dimension: model.dimension,
      addable: Boolean(findCardAddButton(card))
    };
  };
  const mergeRenderedProducts = (target) => {
    for (const card of cards()) {
      const product = trustedProduct(card);
      if (product) target.set(product.productId, product);
    }
  };
  const findExactProductCard = async (productId, onProgress) => {
    window.scrollTo(0, 0);
    await settle(Math.min(300, productSettleMs));
    for (let step = 0; step < maximumScrollSteps; step += 1) {
      const card = cardForProduct(productId);
      if (card) return card;
      const blocker = blockingReason();
      if (blocker) return { blocker };
      onProgress?.(`Finding the exact previewed product (${step + 1}/${maximumScrollSteps})`);
      const nextTop = Math.min(document.documentElement.scrollHeight,
        window.scrollY + Math.max(480, window.innerHeight * 0.8));
      window.scrollTo(0, nextTop);
      await settle();
      if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 24 && step > 2) break;
    }
    return null;
  };

  return Object.freeze({
    retailerName: config.retailerName,
    blockingReason,
    searchUnavailableReason: config.searchUnavailableReason,
    cartUnavailableReason: config.cartUnavailableReason,
    isSearchFor(query) {
      try {
        const url = new URL(location.href);
        return config.isSearchPage(url) && normalizeCartText(config.searchQuery(url)) === normalizeCartText(query);
      } catch { return false; }
    },
    searchUrl(query) {
      try { return config.searchUrl(query, new URL(location.href)); } catch { return null; }
    },
    async queryProducts(query, options) {
      if (typeof config.queryProducts !== 'function') return null;
      try { return await config.queryProducts(query, options); } catch { return null; }
    },
    async directAddProduct(candidate, options) {
      if (typeof config.addProduct !== 'function') return null;
      try { return await config.addProduct(candidate, options); } catch { return null; }
    },
    navigate(url) { location.assign(url); },
    async collectProducts({ onProgress } = {}) {
      // A current snapshot is authoritative for planning and does not depend
      // on lazy image/card rendering.  In particular, do not scroll merely to
      // make a product visible: that was both slow and inconsistent on the
      // retailers' virtualized grids.
      const snapshot = config.trustedSnapshot?.();
      if (snapshot?.accepted === true && Array.isArray(snapshot.products)) {
        onProgress?.(`Using ${snapshot.products.length} verified API result${snapshot.products.length === 1 ? '' : 's'}`);
        return { status: 'complete', products: snapshot.products, source: 'api-snapshot' };
      }
      const products = new Map();
      let stableBottomPasses = 0;
      let previousHeight = -1;
      let confirmedBottom = false;
      window.scrollTo(0, 0);
      await settle(Math.min(350, productSettleMs));
      for (let step = 0; step < maximumScrollSteps; step += 1) {
        const blocker = blockingReason();
        if (blocker) return { status: 'human-required', reason: blocker, products: [...products.values()] };
        mergeRenderedProducts(products);
        onProgress?.(`Loaded ${products.size} verified product${products.size === 1 ? '' : 's'} · scrolling first-page results`);
        const height = document.documentElement.scrollHeight;
        const atBottom = window.scrollY + window.innerHeight >= height - 24;
        stableBottomPasses = atBottom && height === previousHeight ? stableBottomPasses + 1 : 0;
        if (stableBottomPasses >= 2) {
          confirmedBottom = true;
          break;
        }
        previousHeight = height;
        const nextTop = atBottom ? height : Math.min(height,
          window.scrollY + Math.max(480, window.innerHeight * 0.8));
        window.scrollTo(0, nextTop);
        await settle();
      }
      mergeRenderedProducts(products);
      if (!confirmedBottom) {
        return {
          status: 'incomplete',
          reason: `Could not confirm the end of ${config.retailerName}’s first-page results. Scroll to the end once, then continue.`,
          products: [...products.values()]
        };
      }
      return { status: 'complete', products: [...products.values()] };
    },
    async addProduct(candidate, { onProgress } = {}) {
      // A retailer capability is a private, verified API operation captured
      // in the page world. Returning null means it is unavailable or could
      // not prove success, so the established DOM path remains a fallback.
      const located = await findExactProductCard(candidate.productId, onProgress);
      if (located?.blocker) return { status: 'human-required', reason: located.blocker };
      if (!located) return { status: 'missed', reason: 'The exact previewed product was no longer in the loaded results.' };
      located.scrollIntoView({ block: 'center' });
      await wait(120);
      const actionableCard = cardForProduct(candidate.productId);
      const liveProduct = trustedProduct(actionableCard);
      if (!liveProduct) return { status: 'missed', reason: 'The product card changed before its trusted data could be verified.' };
      if (cardHasQuantityControl(actionableCard)) {
        return {
          status: 'added', alreadyPresent: true,
          priceChanged: Math.abs(liveProduct.currentPrice - candidate.currentPrice) > 0.005
        };
      }
      const button = findCardAddButton(actionableCard);
      if (!button) return { status: 'missed', reason: 'The exact product is no longer available to add.' };
      const beforeCount = cartCount();
      try { button.click(); } catch {
        return { status: 'human-required', reason: `A ${config.retailerName} page control blocked the Add action. Resolve it, then continue.` };
      }
      const deadline = Date.now() + addVerifyMs;
      while (Date.now() < deadline) {
        const blocker = blockingReason();
        if (blocker) return { status: 'human-required', reason: blocker };
        const currentCard = cardForProduct(candidate.productId);
        const afterCount = cartCount();
        const countIncreased = beforeCount !== null && afterCount !== null && afterCount > beforeCount;
        // A disappearing Add button is ambiguous: retailer SPAs also remove it
        // during rerenders, errors, and location prompts. Only a quantity
        // control or a conservative cart-count increase confirms success.
        const cardConfirmed = currentCard && cardHasQuantityControl(currentCard);
        if (countIncreased || cardConfirmed) {
          return {
            status: 'added',
            priceChanged: Math.abs(liveProduct.currentPrice - candidate.currentPrice) > 0.005
          };
        }
        await wait(250);
      }
      return { status: 'missed', reason: `${config.retailerName} did not visibly confirm the Add action.` };
    },
    isCartPage() {
      try { return config.isCartPage(new URL(location.href)); } catch { return false; }
    },
    cartUrl() {
      try { return config.cartUrl(new URL(location.href)); } catch { return null; }
    },
    async directReviewCart(candidates = []) {
      if (typeof config.reviewCart !== 'function') return null;
      try { return await config.reviewCart(candidates); } catch { return null; }
    },
    async reviewCart() {
      await wait(500);
      const blocker = blockingReason();
      if (blocker) return { blockingReason: blocker, inspectable: false, presentProductIds: [] };
      const presentProductIds = config.cartProductIds(document);
      return { inspectable: Boolean(config.cartItemEvidence(document)), presentProductIds };
    }
  });
}
