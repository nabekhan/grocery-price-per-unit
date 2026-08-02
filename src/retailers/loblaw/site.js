import { parseProduct } from '../../parsing/parser.js';

function directChildUnder(node, container) {
  let child = node;
  while (child?.parentElement && child.parentElement !== container) child = child.parentElement;
  return child?.parentElement === container ? child : null;
}

export function findProductGrid(document) {
  const listing = document.querySelector('[data-testid="listing-page-container"]');
  const semanticGrids = listing
    ? [...listing.querySelectorAll('[data-testid="product-grid-component"]')]
    : [];
  if (semanticGrids.length) {
    const cards = semanticGrids.flatMap((grid) => [...grid.querySelectorAll(':scope > *')]
      .filter((child) => child.querySelector('[data-testid="product-title"]')));
    if (cards.length >= 3) return [semanticGrids.find((grid) => grid.children.length) || semanticGrids[0], cards, semanticGrids];
  }
  const titles = [...document.querySelectorAll('[data-testid="product-title"]')];
  const candidates = new Map();
  for (const title of titles) {
    let ancestor = title.parentElement;
    while (ancestor && ancestor !== document.body) {
      const count = ancestor.querySelectorAll('[data-testid="product-title"]').length;
      if (count >= 3) {
        const cards = [...new Set(titles.map((item) => directChildUnder(item, ancestor)).filter(Boolean))];
        if (cards.length >= 3) candidates.set(ancestor, cards);
        break;
      }
      ancestor = ancestor.parentElement;
    }
  }
  return [...candidates.entries()].sort((a, b) => b[1].length - a[1].length)[0] || null;
}

function productId(card, index) {
  const link = card.querySelector('a[href*="/product/"], a[href*="/p/"]');
  const href = link?.getAttribute('href') || '';
  return href.match(/(?:product|p)\/([^/?#]+)/)?.[1] || card.getAttribute('data-product-id') || `loaded-${index}`;
}

export function extractCard(card, index = 0, apiProducts = null) {
  const cardProductId = productId(card, index);
  const api = apiProducts?.get(cardProductId) || null;
  const apiPackageText = api?.packageSizing || '';
  const hasExplicitUnitPrice = /\$\s*\d.*(?:\/|\bper\b)/i.test(apiPackageText);
  const input = api ? {
    productId: cardProductId,
    name: api.name,
    currentPrice: api.weighted && !hasExplicitUnitPrice ? null : api.currentPrice,
    regularPrice: api.regularPrice,
    rawPackageText: apiPackageText.split(',')[0] || apiPackageText,
    rawUnitPriceText: apiPackageText.includes(',') ? apiPackageText.slice(apiPackageText.indexOf(',') + 1) : apiPackageText,
    promotionText: '',
    currentPriceCertain: true
  } : {
    productId: cardProductId,
    name: '',
    currentPrice: null,
    regularPrice: null,
    rawPackageText: '',
    rawUnitPriceText: '',
    promotionText: '',
    currentPriceCertain: false
  };
  return {
    ...parseProduct(input),
    dataSource: api ? 'api' : 'missing-api',
    card
  };
}

export function extractGrid(document, apiProducts = null) {
  const match = findProductGrid(document);
  if (!match) return null;
  const [container, cards, containers = [container]] = match;
  return { container, containers, models: cards.map((card, index) => extractCard(card, index, apiProducts)) };
}
