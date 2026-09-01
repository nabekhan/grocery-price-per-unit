import { expect, it } from 'vitest';
import { areOnlyOwnedMutations, MAX_CLASSIFIED_MUTATION_RECORDS } from '../../src/runtime/mutations.js';

it('classifies a bounded owned mutation batch', () => {
  expect(areOnlyOwnedMutations([{ owned: true }, { owned: true }], (record) => record.owned)).toBe(true);
  expect(areOnlyOwnedMutations([{ owned: true }, { owned: false }], (record) => record.owned)).toBe(false);
});

it('conservatively schedules instead of classifying an oversized mutation batch', () => {
  const records = Array.from({ length: MAX_CLASSIFIED_MUTATION_RECORDS + 1 }, () => ({ owned: true }));
  let inspected = 0;
  expect(areOnlyOwnedMutations(records, () => { inspected += 1; return true; })).toBe(false);
  expect(inspected).toBe(0);
});

it('fails conservatively when page-controlled inspection throws', () => {
  expect(areOnlyOwnedMutations([{}], () => { throw new Error('page getter'); })).toBe(false);
});

it('rejects malformed record collections without iterating them', () => {
  expect(areOnlyOwnedMutations(null, () => true)).toBe(false);
  expect(areOnlyOwnedMutations({ length: Number.MAX_SAFE_INTEGER }, () => true)).toBe(false);
});
