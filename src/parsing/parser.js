import { UNITS, canonicalUnit } from './units.js';

const NUMBER = '(\\d+(?:[.,]\\d+)?)';
const UNIT = '(mg|g|kg|oz|lb|ml|l|ea|each|count|ct|pack|rolls?|boxes?|milligrams?|grams?|kilograms?|ounces?|pounds?|millilit(?:re|er)s?|lit(?:re|er)s?)';

function clean(text = '') {
  return String(text).replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function number(raw) {
  if (!raw) return null;
  const normalized = raw.includes(',') && !raw.includes('.') ? raw.replace(',', '.') : raw.replace(/,/g, '');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

export function parseMoney(text) {
  const match = clean(text).match(/\$\s*(\d+(?:[.,]\d{1,2})?)/);
  return match ? number(match[1]) : null;
}

export function parseExplicitUnitPrice(rawText) {
  const text = clean(rawText).toLowerCase();
  if (/fl\.?\s*oz/.test(text)) return { source: 'ambiguous', confidence: 'low', warnings: ['Fluid-ounce standard is not specified.'] };
  const pattern = new RegExp(`\\$\\s*${NUMBER}\\s*(?:\\/|per\\s+)\\s*${NUMBER}?\\s*${UNIT}\\b`, 'i');
  const match = text.match(pattern);
  if (!match) return null;
  const price = number(match[1]);
  const quantity = number(match[2]) || 1;
  const unit = canonicalUnit(match[3]);
  const info = UNITS[unit];
  if (!info || !price || !quantity) return null;
  return {
    dimension: info.dimension,
    normalizedUnitPrice: price / (quantity * info.baseFactor),
    normalizedUnit: info.normalizedUnit,
    source: 'explicit-site-unit-price',
    confidence: 'high',
    warnings: []
  };
}

export function parsePackageQuantity(rawText) {
  const text = clean(rawText).toLowerCase();
  if (!text) return null;
  if (/\b(?:equals?|equiv(?:alent)?)\b|\d+\s*rolls?\s*=/.test(text)) {
    return { source: 'ambiguous', confidence: 'low', warnings: ['Marketing equivalency was not used as physical count.'] };
  }
  if (/fl\.?\s*oz/.test(text)) return { source: 'ambiguous', confidence: 'low', warnings: ['Fluid-ounce standard is not specified.'] };
  let match = text.match(new RegExp(`${NUMBER}\\s*[x×]\\s*${NUMBER}\\s*${UNIT}\\b`, 'i'));
  if (match) {
    const multiplier = number(match[1]);
    const quantity = number(match[2]);
    const unit = canonicalUnit(match[3]);
    const info = UNITS[unit];
    if (info) return { dimension: info.dimension, baseQuantity: multiplier * quantity * info.baseFactor, normalizedUnit: info.normalizedUnit, source: 'calculated-from-package', confidence: 'high', warnings: [] };
  }
  match = text.match(/\b(\d+)\s*[x×]\s*(\d+)\b/i);
  if (match) return { dimension: 'count', baseQuantity: number(match[1]) * number(match[2]), normalizedUnit: '$/each', source: 'calculated-from-package', confidence: 'medium', warnings: ['Interpreted an unlabelled multi-pack as item count.'] };
  match = text.match(new RegExp(`${NUMBER}\\s*${UNIT}\\b`, 'i'));
  if (!match) return null;
  const quantity = number(match[1]);
  const unit = canonicalUnit(match[2]);
  const info = UNITS[unit];
  if (!info || !quantity) return null;
  return { dimension: info.dimension, baseQuantity: quantity * info.baseFactor, normalizedUnit: info.normalizedUnit, source: 'calculated-from-package', confidence: 'high', warnings: [] };
}

export function parseProduct(input) {
  const unit = parseExplicitUnitPrice(input.rawUnitPriceText || input.rawPackageText || '');
  const warnings = [];
  const result = {
    productId: input.productId || null,
    name: clean(input.name),
    currentPrice: input.currentPrice ?? parseMoney(input.currentPriceText),
    regularPrice: input.regularPrice ?? parseMoney(input.regularPriceText),
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
    return { ...result, dimension: quantity.dimension, normalizedUnitPrice: result.currentPrice / quantity.baseQuantity, normalizedUnit: quantity.normalizedUnit, source: 'calculated-from-package', confidence: quantity.confidence, warnings: quantity.warnings };
  }
  if (quantity?.source === 'ambiguous') return { ...result, source: 'ambiguous', confidence: quantity.confidence, warnings: quantity.warnings };
  return result;
}

