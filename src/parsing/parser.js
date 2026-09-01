import { UNITS, canonicalUnit } from './units.js';

/*!
 * Product parsing is a trust boundary, not a best-effort card-text scraper.
 * Callers provide sanitized retailer API fields. Only unambiguous quantities
 * and explicit unit-price denominators become comparable mass, volume, or
 * count values; uncertain input returns no confident ranking.
 */

const NUMBER = '(\\d+(?:[.,]\\d+)?)';
const NUMBER_PREFIX = '(?:^|[^\\p{L}\\p{N}+.,/\\-\\u2212\\u2012\\u2013\\u2014])';
const UNIT = '(mg|g|kg|oz|lb|ml|l|ea|each|count|ct|pack|rolls?|boxes?|milligrams?|grams?|kilograms?|ounces?|pounds?|millilit(?:re|er)s?|lit(?:re|er)s?)';

function clean(text = '') {
  return String(text).replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function number(raw) {
  if (!raw) return null;
  if (/^\d+,\d{3,}$/.test(raw)) return null;
  const normalized = raw.includes(',') && !raw.includes('.') ? raw.replace(',', '.') : raw.replace(/,/g, '');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

const positive = (value) => Number.isFinite(value) && value > 0;
const positiveQuantity = (value) => positive(value) && value <= 1_000_000_000;
const positiveUnitPrice = (value) => positive(value) && value <= 1_000_000_000;
const nonNegativeMoney = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export function parseMoney(text) {
  const match = clean(text).match(/\$\s*(\d+(?:[.,]\d{1,2})?)(?![\p{L}\p{N}.,])/u);
  return match ? number(match[1]) : null;
}

export function parseExplicitUnitPrice(rawText) {
  const text = clean(rawText).toLowerCase();
  if (/fl\.?\s*oz/.test(text)) return { source: 'ambiguous', confidence: 'low', warnings: ['Fluid-ounce standard is not specified.'] };
  const pattern = new RegExp(`\\$\\s*${NUMBER}\\s*(?:\\/|per\\s+)\\s*${NUMBER}?\\s*${UNIT}\\b`, 'i');
  const match = text.match(pattern);
  if (!match) return null;
  const price = number(match[1]);
  const quantity = match[2] == null ? 1 : number(match[2]);
  const unit = canonicalUnit(match[3]);
  const info = UNITS[unit];
  const normalizedUnitPrice = info ? price / (quantity * info.baseFactor) : null;
  if (!info || !positive(price) || !positiveQuantity(quantity) || !positiveUnitPrice(normalizedUnitPrice)) return null;
  return {
    dimension: info.dimension,
    normalizedUnitPrice,
    normalizedUnit: info.normalizedUnit,
    source: 'explicit-site-unit-price',
    confidence: 'high',
    warnings: []
  };
}

export function parsePackageQuantity(rawText) {
  const text = clean(rawText).toLowerCase();
  if (!text) return null;
  if (/\b\d{1,3}(?: \d{3})+\b/.test(text)) return null;
  if (/\b(?:equals?|equiv(?:alent)?)\b|\d+\s*rolls?\s*=/.test(text)) {
    return { source: 'ambiguous', confidence: 'low', warnings: ['Marketing equivalency was not used as physical count.'] };
  }
  if (/fl\.?\s*oz/.test(text)) return { source: 'ambiguous', confidence: 'low', warnings: ['Fluid-ounce standard is not specified.'] };
  let match = text.match(new RegExp(`${NUMBER_PREFIX}${NUMBER}\\s*[x×]\\s*${NUMBER}\\s*${UNIT}\\b`, 'iu'));
  if (match) {
    const multiplier = number(match[1]);
    const quantity = number(match[2]);
    const unit = canonicalUnit(match[3]);
    const info = UNITS[unit];
    const baseQuantity = info ? multiplier * quantity * info.baseFactor : null;
    if (info && positiveQuantity(multiplier) && positiveQuantity(quantity) && positiveQuantity(baseQuantity)) return { dimension: info.dimension, baseQuantity, normalizedUnit: info.normalizedUnit, source: 'calculated-from-package', confidence: 'high', warnings: [] };
    return null;
  }
  match = text.match(new RegExp(`${NUMBER_PREFIX}(\\d+)\\s*[x×]\\s*(\\d+)(?![\\d.,])`, 'iu'));
  if (match) {
    const multiplier = number(match[1]);
    const quantity = number(match[2]);
    const baseQuantity = multiplier * quantity;
    if (!positiveQuantity(multiplier) || !positiveQuantity(quantity) || !positiveQuantity(baseQuantity)) return null;
    return { dimension: 'count', baseQuantity, normalizedUnit: '$/each', source: 'calculated-from-package', confidence: 'medium', warnings: ['Interpreted an unlabelled multi-pack as item count.'] };
  }
  match = text.match(new RegExp(`${NUMBER_PREFIX}${NUMBER}\\s*${UNIT}\\b`, 'iu'));
  if (!match) return null;
  const quantity = number(match[1]);
  const unit = canonicalUnit(match[2]);
  const info = UNITS[unit];
  const baseQuantity = info ? quantity * info.baseFactor : null;
  if (!info || !positiveQuantity(quantity) || !positiveQuantity(baseQuantity)) return null;
  return { dimension: info.dimension, baseQuantity, normalizedUnit: info.normalizedUnit, source: 'calculated-from-package', confidence: 'high', warnings: [] };
}

export function parseProduct(input) {
  const unit = parseExplicitUnitPrice(input.rawUnitPriceText || input.rawPackageText || '');
  const warnings = [];
  const currentPrice = input.currentPrice == null ? parseMoney(input.currentPriceText) : nonNegativeMoney(input.currentPrice);
  const regularPrice = input.regularPrice == null ? parseMoney(input.regularPriceText) : nonNegativeMoney(input.regularPrice);
  const result = {
    productId: input.productId || null,
    name: clean(input.name),
    currentPrice,
    regularPrice,
    rawPackageText: clean(input.rawPackageText),
    rawUnitPriceText: clean(input.rawUnitPriceText),
    dimension: null,
    normalizedUnitPrice: null,
    normalizedUnit: null,
    source: 'unknown',
    confidence: 'none',
    warnings
  };
  if (unit) return { ...result, ...unit, warnings: [...warnings, ...(unit.warnings || [])] };
  const promoText = clean(input.promotionText);
  const conditional = /\b(?:min(?:imum)?\s*\d+|\d+\s*for\s*\$|member|after limit)\b/i.test(promoText);
  if (conditional && !input.currentPriceCertain) {
    return { ...result, source: 'ambiguous', confidence: 'low', warnings: ['Conditional promotion was not treated as a certain single-item price.'] };
  }
  const quantity = parsePackageQuantity(input.rawPackageText);
  if (quantity?.dimension && result.currentPrice != null) {
    const normalizedUnitPrice = result.currentPrice / quantity.baseQuantity;
    if (positiveUnitPrice(normalizedUnitPrice)) {
      return { ...result, dimension: quantity.dimension, normalizedUnitPrice, normalizedUnit: quantity.normalizedUnit, source: 'calculated-from-package', confidence: quantity.confidence, warnings: quantity.warnings };
    }
  }
  if (quantity?.source === 'ambiguous') return { ...result, source: 'ambiguous', confidence: quantity.confidence, warnings: quantity.warnings };
  return result;
}
