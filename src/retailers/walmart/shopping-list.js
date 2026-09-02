import { claimRuntimeInstall } from '../../runtime/install.js';
import { createShoppingListRunner } from '../../runtime/shopping-list-runner.js';
import { readApiScanModel, readApiScanState } from './scan-state.js';
import { isWalmartSearchPage } from './routes.js';

/*!
 * Walmart shopping-list adapter.
 *
 * The shared runner owns workflow, persistence, and UI. This file deliberately
 * owns everything coupled to Walmart's page: URL shape, lazy result loading,
 * product-card identity, Add controls, human-verification detection, and cart
 * inspection. Candidate prices and names come only from the private API-backed
 * WeakMap published by content.js; page text is never promoted to price data.
 */

const CARD_SELECTOR = '[data-item-id]';
const MAX_SCROLL_STEPS = 28;
const PRODUCT_SETTLE_MS = 650;
const ADD_VERIFY_MS = 8_000;

const normalize = (value) => String(value || '').trim().normalize('NFKC').replace(/\s+/g, ' ').toLowerCase();
const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

function visible(element) {
  if (!(element instanceof Element) || element.hidden) return false;
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden'
    && Number(style.opacity || 1) !== 0 && element.getClientRects().length > 0;
}

function accessibleName(element) {
  return normalize(element.getAttribute('aria-label') || element.getAttribute('title')
    || element.innerText || element.textContent);
}

function isAddName(name) {
  return /^(?:add|add to cart)(?:\b|$)/i.test(name) && !/^(?:added|add-ons?)(?:\b|$)/i.test(name);
}

/** Find an Add control only inside the card whose trusted product ID matched. */
export function findWalmartAddButton(card, { requireVisible = true } = {}) {
  if (!(card instanceof Element)) return null;
  const controls = card.querySelectorAll('button,[role="button"]');
  for (const control of controls) {
    if (control.matches(':disabled,[aria-disabled="true"]')) continue;
    if (requireVisible && !visible(control)) continue;
    if (isAddName(accessibleName(control))) return control;
  }
  return null;
}

function quantityControlPresent(card) {
  return [...card.querySelectorAll('button,[role="button"],input')].some((control) => {
    const name = accessibleName(control);
    return /(?:increase|decrease|remove).*(?:quantity|item)|(?:quantity|item).*(?:increase|decrease|remove)/i.test(name)
      || /quantity/i.test(control.getAttribute('data-automation-id') || control.getAttribute('data-testid') || '');
  });
}

function cardForProduct(productId) {
  return [...document.querySelectorAll(CARD_SELECTOR)]
    .find((card) => card.getAttribute('data-item-id') === productId) || null;
}

function currentTrustedProduct(card) {
  const state = readApiScanState();
  if (!state?.accepted) return null;
  const model = readApiScanModel(state, card);
  if (!model?.matched || !model.productId || !model.name || !model.currentPrice) return null;
  return {
    matched: true,
    productId: model.productId,
    name: model.name,
    currentPrice: model.currentPrice,
    normalizedUnitPrice: model.normalizedUnitPrice,
    dimension: model.dimension,
    addable: Boolean(findWalmartAddButton(card))
  };
}

function mergeRenderedProducts(target) {
  for (const card of document.querySelectorAll(CARD_SELECTOR)) {
    const product = currentTrustedProduct(card);
    if (product) target.set(product.productId, product);
  }
}

function productUpdateOrDelay(milliseconds = PRODUCT_SETTLE_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener('ppu-products-updated', finish);
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, milliseconds);
    window.addEventListener('ppu-products-updated', finish, { once: true });
  });
}

function dialogText() {
  const selectors = [
    'iframe[src*="captcha" i]', '[id*="captcha" i]', '[class*="captcha" i]',
    '[role="dialog"]', '[aria-modal="true"]'
  ];
  for (const element of document.querySelectorAll(selectors.join(','))) {
    if (!visible(element)) continue;
    const text = normalize(element.getAttribute('title') || element.textContent);
    if (/captcha|verify (?:you are|that you are|your identity)|robot|human verification|access denied/.test(text)) {
      return 'Walmart needs human verification. Complete it in the page, then choose “I resolved it — continue”.';
    }
    if (/cookie|privacy (?:choice|preference)|accept all|select (?:a )?store|choose (?:a )?(?:store|location)/.test(text)) {
      return 'A Walmart cookie, store, or location dialog needs your choice. Resolve it in the page, then continue.';
    }
  }
  return null;
}

function cartCount() {
  const selectors = [
    'a[href*="/cart"]', '[data-automation-id*="cart" i]', '[data-testid*="cart" i]',
    '[aria-label*="cart" i]'
  ];
  for (const element of document.querySelectorAll(selectors.join(','))) {
    if (!visible(element)) continue;
    const match = accessibleName(element).match(/(?:cart\D{0,16})?(\d{1,3})(?:\D|$)/i);
    if (match) return Number(match[1]);
  }
  return null;
}

function terminalPathSegment() {
  return location.pathname.split('/').filter(Boolean).at(-1)?.toLowerCase() || '';
}

function urlQuery() {
  try { return normalize(new URL(location.href).searchParams.get('q')); } catch { return ''; }
}

async function findExactProductCard(productId, onProgress) {
  window.scrollTo(0, 0);
  await productUpdateOrDelay(300);
  for (let step = 0; step < MAX_SCROLL_STEPS; step += 1) {
    const card = cardForProduct(productId);
    if (card) return card;
    const blocker = dialogText();
    if (blocker) return { blocker };
    onProgress?.(`Finding the exact previewed product (${step + 1}/${MAX_SCROLL_STEPS})`);
    const nextTop = Math.min(document.documentElement.scrollHeight, window.scrollY + Math.max(480, window.innerHeight * 0.8));
    window.scrollTo(0, nextTop);
    await productUpdateOrDelay();
    const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 24;
    if (atBottom && step > 2) break;
  }
  return null;
}

/** Extract product IDs without trusting cart text or prices. */
export function walmartCartProductIds(root = document) {
  const ids = new Set();
  for (const card of root.querySelectorAll?.(CARD_SELECTOR) || []) {
    const id = card.getAttribute('data-item-id');
    if (id) ids.add(id);
  }
  for (const anchor of root.querySelectorAll?.('a[href*="/ip/"]') || []) {
    try {
      const segments = new URL(anchor.href, location.origin).pathname.split('/').filter(Boolean);
      const ipIndex = segments.indexOf('ip');
      const id = ipIndex >= 0 ? segments.at(-1) : null;
      if (id && id !== 'ip') ids.add(decodeURIComponent(id));
    } catch { /* malformed page links are not cart evidence */ }
  }
  return [...ids];
}

export function createWalmartShoppingAdapter() {
  return Object.freeze({
    retailerName: 'Walmart',
    blockingReason: dialogText,
    isSearchFor(query) {
      try { return isWalmartSearchPage(new URL(location.href)) && urlQuery() === normalize(query); } catch { return false; }
    },
    searchUrl(query) {
      const url = new URL('/en/search', location.origin);
      url.searchParams.set('q', String(query));
      return url.href;
    },
    navigate(url) { location.assign(url); },

    async collectProducts({ onProgress } = {}) {
      const products = new Map();
      let stableBottomPasses = 0;
      let previousHeight = -1;
      window.scrollTo(0, 0);
      await productUpdateOrDelay(350);
      for (let step = 0; step < MAX_SCROLL_STEPS; step += 1) {
        const blocker = dialogText();
        if (blocker) return { status: 'human-required', reason: blocker, products: [...products.values()] };
        mergeRenderedProducts(products);
        onProgress?.(`Loaded ${products.size} verified product${products.size === 1 ? '' : 's'} · scrolling first-page results`);
        const height = document.documentElement.scrollHeight;
        const atBottom = window.scrollY + window.innerHeight >= height - 24;
        stableBottomPasses = atBottom && height === previousHeight ? stableBottomPasses + 1 : 0;
        if (stableBottomPasses >= 2) break;
        previousHeight = height;
        const nextTop = atBottom ? height : Math.min(height, window.scrollY + Math.max(480, window.innerHeight * 0.8));
        window.scrollTo(0, nextTop);
        await productUpdateOrDelay();
      }
      mergeRenderedProducts(products);
      return { status: 'complete', products: [...products.values()] };
    },

    async addProduct(candidate, { onProgress } = {}) {
      const located = await findExactProductCard(candidate.productId, onProgress);
      if (located?.blocker) return { status: 'human-required', reason: located.blocker };
      if (!located) return { status: 'missed', reason: 'The exact previewed product was no longer in the loaded results.' };
      located.scrollIntoView({ block: 'center' });
      await wait(120);
      // Walmart virtualizes cards aggressively. Re-resolve both card identity
      // and trusted model after scrolling rather than clicking a detached node.
      const actionableCard = cardForProduct(candidate.productId);
      const liveProduct = currentTrustedProduct(actionableCard);
      if (!liveProduct || liveProduct.productId !== candidate.productId) {
        return { status: 'missed', reason: 'The product card changed before its trusted Walmart data could be verified.' };
      }
      if (quantityControlPresent(actionableCard)) {
        return {
          status: 'added', alreadyPresent: true,
          priceChanged: Math.abs(liveProduct.currentPrice - candidate.currentPrice) > 0.005
        };
      }
      const button = findWalmartAddButton(actionableCard);
      if (!button) return { status: 'missed', reason: 'The exact product is no longer available to add.' };
      const beforeCount = cartCount();
      try { button.click(); } catch {
        return { status: 'human-required', reason: 'A Walmart page control blocked the Add action. Resolve it, then continue.' };
      }
      const deadline = Date.now() + ADD_VERIFY_MS;
      while (Date.now() < deadline) {
        const blocker = dialogText();
        if (blocker) return { status: 'human-required', reason: blocker };
        const currentCard = cardForProduct(candidate.productId);
        const afterCount = cartCount();
        const countIncreased = beforeCount !== null && afterCount !== null && afterCount > beforeCount;
        const cardConfirmed = currentCard && (quantityControlPresent(currentCard) || !findWalmartAddButton(currentCard));
        if (countIncreased || cardConfirmed) {
          return {
            status: 'added',
            priceChanged: Math.abs(liveProduct.currentPrice - candidate.currentPrice) > 0.005
          };
        }
        await wait(250);
      }
      return { status: 'missed', reason: 'Walmart did not visibly confirm the Add action within eight seconds.' };
    },

    isCartPage() { return terminalPathSegment() === 'cart'; },
    cartUrl() { return new URL('/en/cart', location.origin).href; },
    async reviewCart() {
      await wait(500);
      const blocker = dialogText();
      if (blocker) return { blockingReason: blocker, inspectable: false, presentProductIds: [] };
      const presentProductIds = walmartCartProductIds();
      const itemEvidence = document.querySelector(
        `${CARD_SELECTOR},a[href*="/ip/"],[data-testid*="cart-item" i],[data-automation-id*="cart-item" i]`
      );
      return { inspectable: Boolean(itemEvidence), presentProductIds };
    }
  });
}

export function installWalmartShoppingList() {
  if (!claimRuntimeInstall('walmart-shopping-list')) return false;
  createShoppingListRunner({ retailerId: 'walmart', adapter: createWalmartShoppingAdapter() }).install();
  return true;
}
