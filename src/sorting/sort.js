export const DIMENSIONS = ['mass', 'volume', 'count'];

export function predominantDimension(items) {
  const counts = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, 0]));
  for (const item of items) if (item.dimension && Number.isFinite(item.normalizedUnitPrice)) counts[item.dimension] += 1;
  return DIMENSIONS.reduce((best, candidate) => counts[candidate] > counts[best] ? candidate : best, 'mass');
}

export function sortModels(items, { dimension = 'auto', direction = 'asc' } = {}) {
  const hasUnitPrices = items.some((item) => DIMENSIONS.includes(item.dimension) && Number.isFinite(item.normalizedUnitPrice));
  const selected = dimension === 'auto' ? (hasUnitPrices ? predominantDimension(items) : 'total') : dimension;
  const sign = direction === 'desc' ? -1 : 1;
  const value = (item) => selected === 'total' ? item.currentPrice : item.normalizedUnitPrice;
  const remainingDimensions = DIMENSIONS.filter((candidate) => candidate !== selected);
  const group = (item) => {
    if (selected === 'total') return Number.isFinite(item.currentPrice) ? 0 : Number.MAX_SAFE_INTEGER;
    if (item.dimension === selected && Number.isFinite(item.normalizedUnitPrice)) return 0;
    const index = remainingDimensions.indexOf(item.dimension);
    return index >= 0 && Number.isFinite(item.normalizedUnitPrice) ? index + 1 : Number.MAX_SAFE_INTEGER;
  };
  return {
    dimension: selected,
    items: items.map((item, index) => ({ item, index })).sort((a, b) => {
      const aGroup = group(a.item);
      const bGroup = group(b.item);
      if (aGroup !== bGroup) return aGroup - bGroup;
      if (aGroup === Number.MAX_SAFE_INTEGER) return a.index - b.index;
      return sign * (value(a.item) - value(b.item)) || a.index - b.index;
    }).map(({ item }) => item)
  };
}
