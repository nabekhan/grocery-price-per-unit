/*!
 * Canonical conversion factors normalize quantities to kilograms, litres, or
 * items while retaining an explicit dimension for comparison safety.
 */
export const UNITS = Object.freeze({
  mg: { dimension: 'mass', baseFactor: 0.000001, normalizedUnit: '$/kg' },
  g: { dimension: 'mass', baseFactor: 0.001, normalizedUnit: '$/kg' },
  kg: { dimension: 'mass', baseFactor: 1, normalizedUnit: '$/kg' },
  oz: { dimension: 'mass', baseFactor: 0.028349523125, normalizedUnit: '$/kg' },
  lb: { dimension: 'mass', baseFactor: 0.45359237, normalizedUnit: '$/kg' },
  ml: { dimension: 'volume', baseFactor: 0.001, normalizedUnit: '$/L' },
  l: { dimension: 'volume', baseFactor: 1, normalizedUnit: '$/L' },
  ea: { dimension: 'count', baseFactor: 1, normalizedUnit: '$/each' },
  each: { dimension: 'count', baseFactor: 1, normalizedUnit: '$/each' },
  count: { dimension: 'count', baseFactor: 1, normalizedUnit: '$/each' },
  ct: { dimension: 'count', baseFactor: 1, normalizedUnit: '$/each' },
  pack: { dimension: 'count', baseFactor: 1, normalizedUnit: '$/each' },
  rolls: { dimension: 'count', baseFactor: 1, normalizedUnit: '$/each' },
  roll: { dimension: 'count', baseFactor: 1, normalizedUnit: '$/each' },
  boxes: { dimension: 'count', baseFactor: 1, normalizedUnit: '$/each' },
  box: { dimension: 'count', baseFactor: 1, normalizedUnit: '$/each' }
});

export function canonicalUnit(raw) {
  const key = raw.toLowerCase().replace(/\./g, '');
  const aliases = { milligram: 'mg', milligrams: 'mg', gram: 'g', grams: 'g', kilogram: 'kg', kilograms: 'kg', ounce: 'oz', ounces: 'oz', pound: 'lb', pounds: 'lb', millilitre: 'ml', millilitres: 'ml', milliliter: 'ml', milliliters: 'ml', litre: 'l', litres: 'l', liter: 'l', liters: 'l', pcs: 'count', pieces: 'count', pc: 'count', units: 'count' };
  return aliases[key] || key;
}
