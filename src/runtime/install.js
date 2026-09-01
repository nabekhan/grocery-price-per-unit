/*!
 * Synchronous per-page claims prevent duplicate controls, observers, timers,
 * and message handlers when a script manager evaluates this file twice.
 */
export function claimRuntimeInstall(name) {
  const key = Symbol.for(`grocery-price-per-unit.runtime.${name}.v1`);
  try {
    if (globalThis[key]) return false;
    Object.defineProperty(globalThis, key, {
      configurable: false,
      enumerable: false,
      value: true
    });
    return true;
  } catch {
    return false;
  }
}
