import { describe, expect, it } from 'vitest';
import { formatUnitPrice, speakUnitPrice } from '../../src/ui/format.js';

describe('unit-price presentation', () => {
  it.each([
    [2, '$/kg', '$2.00/kg'],
    [2, 'CAD/kg', '$2.00/kg'],
    [1.6, '$/L', '$1.60/L'],
    [1.6, 'CAD/L', '$1.60/L'],
    [0.25, '$/each', '$0.25/each'],
    [0.25, 'CAD/item', '$0.25/each']
  ])('formats %s %s with a leading currency symbol', (value, unit, expected) => {
    expect(formatUnitPrice(value, unit)).toBe(expected);
  });

  it.each([
    [2, '$/kg', '$2.00 per kilogram'],
    [2, 'CAD/kg', '$2.00 per kilogram'],
    [1.6, '$/L', '$1.60 per litre'],
    [1.6, 'CAD/L', '$1.60 per litre'],
    [0.25, '$/each', '$0.25 each'],
    [0.25, 'CAD/item', '$0.25 each']
  ])('speaks %s %s naturally', (value, unit, expected) => {
    expect(speakUnitPrice(value, unit)).toBe(expected);
  });
});
