import { describe, expect, it } from 'vitest';
import { predominantDimension, sortModels } from '../../src/sorting/sort.js';

const models = [
  { productId: 'm2', dimension: 'mass', normalizedUnitPrice: 5 },
  { productId: 'v2', dimension: 'volume', normalizedUnitPrice: 3 },
  { productId: 'v1', dimension: 'volume', normalizedUnitPrice: 1 },
  { productId: 'm1a', dimension: 'mass', normalizedUnitPrice: 2 },
  { productId: 'unknown', dimension: null, normalizedUnitPrice: null },
  { productId: 'm1b', dimension: 'mass', normalizedUnitPrice: 2 }
];

describe('dimension-aware stable sorting', () => {
  it('selects predominant dimension', () => expect(predominantDimension(models)).toBe('mass'));
  it('sorts each unit group independently and leaves unknowns last', () => {
    const result = sortModels(models);
    expect(result.items.map((m) => m.productId)).toEqual(['m1a', 'm1b', 'm2', 'v1', 'v2', 'unknown']);
    expect(result.range).toEqual({ minimum: 2, maximum: 5 });
  });
  it('reverses every compatible unit group without comparing unlike units', () => {
    expect(sortModels(models, { dimension: 'mass', direction: 'desc' }).items.map((m) => m.productId)).toEqual(['m2', 'm1a', 'm1b', 'v2', 'v1', 'unknown']);
  });
  it('filters by explicit dimension', () => expect(sortModels(models, { dimension: 'volume' }).items[0].productId).toBe('v1'));
  it('falls back to total price only when the page has no usable unit prices', () => {
    const unknowns = [
      { productId: 'expensive', currentPrice: 9, dimension: null, normalizedUnitPrice: null },
      { productId: 'missing', currentPrice: null, dimension: null, normalizedUnitPrice: null },
      { productId: 'zero-sentinel', currentPrice: 0, dimension: null, normalizedUnitPrice: null },
      { productId: 'negative-zero-sentinel', currentPrice: -0, dimension: null, normalizedUnitPrice: null },
      { productId: 'cheap', currentPrice: 2, dimension: null, normalizedUnitPrice: null }
    ];
    const result = sortModels(unknowns);
    expect(result.dimension).toBe('total');
    expect(result.range).toEqual({ minimum: 2, maximum: 9 });
    expect(result.items.map((item) => item.productId)).toEqual([
      'cheap', 'expensive', 'missing', 'zero-sentinel', 'negative-zero-sentinel'
    ]);
    expect(sortModels(models).dimension).toBe('mass');
  });
  it('omits a range unless the selected group has two distinct finite values', () => {
    expect(sortModels([{ productId: 'only', dimension: 'count', normalizedUnitPrice: 0.5 }], { dimension: 'count' }).range).toBeNull();
    expect(sortModels([
      { productId: 'one', dimension: 'count', normalizedUnitPrice: 0.5 },
      { productId: 'two', dimension: 'count', normalizedUnitPrice: 0.5 }
    ], { dimension: 'count' }).range).toBeNull();
  });
});
