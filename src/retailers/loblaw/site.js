import { parseProduct } from '../../parsing/parser.js';
import { MAX_RENDERED_CARDS } from '../limits.js';

/*!
 * Loblaw DOM boundary. A selected result grid must contain genuine product
 * title/link cards and remain under the shared work cap. API IDs come from
 * stable product links; card text is display context, never price authority.
 */

export function findProductGrid(document) {
  const listing = document.querySelector('[data-testid="listing-page-container"]');
  const semanticGridNodes = listing?.querySelectorAll('[data-testid="product-grid-component"]');
  if (semanticGridNodes?.length > MAX_RENDERED_CARDS) return null;
  const semanticGrids = semanticGridNodes ? [...semanticGridNodes] : [];
  if (semanticGrids.length) {
    const cards = [];
    let inspectedChildren = 0;
    for (const grid of semanticGrids) {
      if (inspectedChildren + grid.children.length > MAX_RENDERED_CARDS) return null;
      inspectedChildren += grid.children.length;
      for (const child of grid.children) {
        if (child.querySelector('[data-testid="product-title"]')) cards.push(child);
      }
    }
    if (cards.length >= 3) return [semanticGrids.find((grid) => grid.children.length) || semanticGrids[0], cards, semanticGrids];
  }
  const titleNodes = document.querySelectorAll('[data-testid="product-title"]');
  if (titleNodes.length > MAX_RENDERED_CARDS) return null;
  const candidates = new Map();
  for (const title of titleNodes) {
    let branch = title;
    let ancestor = title.parentElement;
    let depth = 0;
    while (ancestor && ancestor !== document.body && depth < 24) {
      if (!candidates.has(ancestor)) candidates.set(ancestor, new Set());
      candidates.get(ancestor).add(branch);
      branch = ancestor;
      ancestor = ancestor.parentElement;
      depth += 1;
    }
  }
  const match = [...candidates.entries()]
    .filter(([, cards]) => cards.size >= 3)
    .sort((left, right) => right[1].size - left[1].size)[0];
  return match ? [match[0], [...match[1]]] : null;
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
