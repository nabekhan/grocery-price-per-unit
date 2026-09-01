/*!
 * Mutation classification is bounded before adapter-specific predicates run.
 * Known userscript-owned changes may be ignored to avoid feedback loops;
 * malformed or oversized batches trigger one fresh scan and fail open.
 */
export const MAX_CLASSIFIED_MUTATION_RECORDS = 1_000;

export function areOnlyOwnedMutations(records, isOwnedMutation) {
  if (!records || !Number.isSafeInteger(records.length)
    || records.length < 0 || records.length > MAX_CLASSIFIED_MUTATION_RECORDS) return false;
  try {
    for (let index = 0; index < records.length; index += 1) {
      if (!isOwnedMutation(records[index])) return false;
    }
    return true;
  } catch {
    return false;
  }
}
