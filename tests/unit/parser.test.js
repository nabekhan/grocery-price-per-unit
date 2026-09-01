import { describe, expect, it } from 'vitest';
import { parseExplicitUnitPrice, parsePackageQuantity, parseProduct } from '../../src/parsing/parser.js';

describe('explicit unit prices', () => {
  const cases = [
    ['$1.49/100g', 'mass', 14.9], ['$23.99/1kg', 'mass', 23.99], ['$10.88/1lb', 'mass', 10.88 / 0.45359237],
    ['$0.50/100ml', 'volume', 5], ['$3.44/1ea', 'count', 3.44], ['$ 1,49 / 100 G', 'mass', 14.9],
    [`$0.50\u00a0/\u00a0100 mL`, 'volume', 5]
  ];
  it.each(cases)('%s normalizes', (raw, dimension, expected) => {
    const value = parseExplicitUnitPrice(raw);
    expect(value.dimension).toBe(dimension);
    expect(value.normalizedUnitPrice).toBeCloseTo(expected, 6);
  });
  it('rejects ambiguous fluid ounces', () => expect(parseExplicitUnitPrice('$1.00/fl oz').source).toBe('ambiguous'));
  it('returns null for malformed values', () => expect(parseExplicitUnitPrice('$wat/100g')).toBeNull());
  it.each(['$1.00/0 g', '$0.50/1,000 g'])('rejects unsafe explicit denominator %s', (raw) => {
    expect(parseExplicitUnitPrice(raw)).toBeNull();
  });
});

describe('package quantities', () => {
  const cases = [
    ['400 g', 'mass', 0.4], ['1 L', 'volume', 1], ['750 mL', 'volume', 0.75],
    ['6 x 355 mL', 'volume', 2.13], ['24 × 500 mL', 'volume', 12], ['2 x 500 g', 'mass', 1],
    ['12 pack', 'count', 12], ['18 count', 'count', 18], ['24 rolls', 'count', 24], ['6 boxes', 'count', 6], ['2 x 12', 'count', 24]
  ];
  it.each(cases)('%s normalizes quantity', (raw, dimension, expected) => {
    const value = parsePackageQuantity(raw);
    expect(value.dimension).toBe(dimension);
    expect(value.baseQuantity).toBeCloseTo(expected, 8);
  });
  it('does not use marketing equivalencies', () => expect(parsePackageQuantity('3 rolls = 6 regular rolls').source).toBe('ambiguous'));
  it('handles missing and malformed quantities', () => {
    expect(parsePackageQuantity('family size')).toBeNull();
    expect(parsePackageQuantity('?? g')).toBeNull();
  });
  it.each(['1e-7 g', '1e+308 g', '-500 g', '+500 g', '−500 g', '1/2 kg', 'abc500 g', 'é500 g', '1,000 g'])('rejects unsafe numeric token %s', (raw) => {
    expect(parsePackageQuantity(raw)).toBeNull();
  });
  it.each(['0 g', '0 x 500 g', '2 x 0 g', `${'9'.repeat(200)} x 2 g`])('rejects non-positive or overflowing quantity %s', (raw) => {
    expect(parsePackageQuantity(raw)).toBeNull();
  });
  it('preserves a bounded decimal-comma quantity', () => {
    expect(parsePackageQuantity('1,49 kg')).toMatchObject({ dimension: 'mass', baseQuantity: 1.49 });
  });
  it.each(['1 500 g', `1\u00a0500 g`, `1\u202f500 g`])('rejects ambiguous grouped-space quantity %s', (raw) => {
    expect(parsePackageQuantity(raw)).toBeNull();
  });
});

describe('product precedence and promotions', () => {
  it('prefers retailer unit price over approximate package calculation', () => {
    const value = parseProduct({ currentPrice: 12, rawPackageText: 'approximately 800 g', rawUnitPriceText: '$10.88/1lb' });
    expect(value.source).toBe('explicit-site-unit-price');
    expect(value.normalizedUnitPrice).toBeCloseTo(23.986, 2);
  });
  it('calculates from effective sale price', () => {
    const value = parseProduct({ currentPrice: 5.5, regularPrice: 6.5, rawPackageText: '1 L' });
    expect(value.normalizedUnitPrice).toBe(5.5);
  });
  it('marks an uncertain multi-buy ambiguous', () => {
    const value = parseProduct({ currentPriceText: '$2.50', rawPackageText: '1 ea', promotionText: '2 for $5 MIN 2' });
    expect(value.source).toBe('ambiguous');
  });
  it('does not invent a value without quantity', () => expect(parseProduct({ currentPrice: 4, rawPackageText: 'family size' }).source).toBe('unknown'));
  it('does not turn malformed numeric suffixes into sortable unit prices', () => {
    const value = parseProduct({ currentPrice: 7, rawPackageText: '1e-7 g' });
    expect(value.source).toBe('unknown');
    expect(value.normalizedUnitPrice).toBeNull();
  });
  it('rejects non-finite and negative caller prices', () => {
    expect(parseProduct({ currentPrice: Infinity, rawPackageText: '1 kg' }).normalizedUnitPrice).toBeNull();
    expect(parseProduct({ currentPrice: -1, rawPackageText: '1 kg' }).normalizedUnitPrice).toBeNull();
  });
  it.each(['$1e3', '$1abc', '$1é'])('rejects malformed money token %s', (raw) => {
    expect(parseProduct({ currentPriceText: raw, rawPackageText: '1 kg' })).toMatchObject({
      source: 'unknown', normalizedUnitPrice: null
    });
  });
  it('does not rank zero-price package calculations as certain value', () => {
    expect(parseProduct({ currentPrice: 0, rawPackageText: '1 kg' })).toMatchObject({
      source: 'unknown', normalizedUnitPrice: null
    });
  });
});
