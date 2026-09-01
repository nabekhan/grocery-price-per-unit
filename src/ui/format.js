/*!
 * Presentation-only formatting: compact visible labels and expanded Canadian
 * English for assistive technology. These strings never feed parsing/sorting.
 */
const UNIT_FORMATS = new Map([
  ['$/kg', { visible: 'kg', spoken: 'per kilogram' }],
  ['$/L', { visible: 'L', spoken: 'per litre' }],
  ['$/each', { visible: 'each', spoken: 'each' }]
]);

function normalizedUnit(unit) {
  const value = String(unit || '');
  if (value === 'CAD/item') return '$/each';
  return value.replace(/^CAD\//, '$/');
}

export function formatUnitPrice(value, unit) {
  if (!Number.isFinite(value)) return null;
  const normalized = normalizedUnit(unit);
  const format = UNIT_FORMATS.get(normalized);
  return format ? `$${value.toFixed(2)}/${format.visible}` : `${value.toFixed(2)} ${normalized}`.trim();
}

export function speakUnitPrice(value, unit) {
  if (!Number.isFinite(value)) return null;
  const normalized = normalizedUnit(unit);
  const format = UNIT_FORMATS.get(normalized);
  return format ? `$${value.toFixed(2)} ${format.spoken}` : `${value.toFixed(2)} ${normalized}`.trim();
}
