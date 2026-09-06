/**
 * Structural equality for JSON-shaped values. Used by the Settings screen
 * to tell an edited draft from the persisted config (`isDirty`), which
 * decides whether closing the dialog needs a confirmation.
 *
 * A `JSON.stringify` comparison would almost work here, but it silently
 * depends on key *order* being identical on both sides -- the draft is a
 * clone that gets mutated, the persisted copy comes back rebuilt by
 * `normalizeAppConfig`, so that assumption is one refactor away from
 * breaking and would show up as a phantom "unsaved changes" prompt. This
 * compares structure instead. Pure, so the Vitest suite covers it.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  // NaN === NaN is false, but two NaNs are equal for our purposes.
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(bObj, key) && deepEqual(aObj[key], bObj[key]),
  );
}
