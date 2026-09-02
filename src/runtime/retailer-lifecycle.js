/*!
 * Shared retailer lifecycle and scan scheduling.
 *
 * Retailer adapters report only trustworthy current-scope snapshots. The
 * lifecycle turns absence of such a snapshot into a bounded state transition:
 * pending first, then an actionable user-operated reload state. It never
 * initiates a retailer request, reloads automatically, or treats DOM text as
 * product truth.
 */

const MAX_SCOPE_LENGTH = 4096;

function validScope(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SCOPE_LENGTH ? value : null;
}

export function captureWaitState(lifecycle, scope) {
  return lifecycle?.state(scope) === 'reload-needed' ? 'reload-needed' : 'pending';
}

export function createScanScheduler(global, scan, { delayMs = 180 } = {}) {
  if (typeof scan !== 'function') throw new TypeError('Scan scheduler requires a scan function');
  let timer = null;
  let frame = null;
  let disposed = false;
  const clearTimer = () => {
    if (timer === null) return;
    global.clearTimeout(timer);
    timer = null;
  };
  const clearFrame = () => {
    if (frame === null) return;
    if (typeof global.cancelAnimationFrame === 'function') global.cancelAnimationFrame(frame);
    else global.clearTimeout(frame);
    frame = null;
  };
  const run = () => {
    timer = null;
    frame = null;
    if (!disposed) scan();
  };
  const schedule = ({ urgent = false } = {}) => {
    if (disposed) return false;
    if (urgent) {
      clearTimer();
      if (frame !== null) return false;
      frame = typeof global.requestAnimationFrame === 'function'
        ? global.requestAnimationFrame(run)
        : global.setTimeout(run, 0);
      return true;
    }
    if (timer !== null || frame !== null) return false;
    timer = global.setTimeout(run, delayMs);
    return true;
  };
  schedule.dispose = () => {
    disposed = true;
    clearTimer();
    clearFrame();
  };
  return schedule;
}

export function createRetailerLifecycle({
  global,
  id,
  getScope,
  installedAtDocumentStart,
  lateGraceMs = 1200,
  scopeGraceMs = 4500
}) {
  if (typeof getScope !== 'function') throw new TypeError(`Retailer plugin ${id} must provide getScope`);
  const listeners = new Set();
  let acceptedScope = null;
  let waitingScope = null;
  let recoveryScope = null;
  let recoveryTimer = null;
  let firstWait = true;
  let disposed = false;

  const currentScope = () => {
    try { return validScope(getScope(global)); } catch { return null; }
  };
  const clearRecoveryTimer = () => {
    if (recoveryTimer === null) return;
    global.clearTimeout(recoveryTimer);
    recoveryTimer = null;
  };
  const notify = (reason, scope) => {
    for (const listener of listeners) {
      try { listener(Object.freeze({ reason, scope })); } catch { /* isolate adapter listeners */ }
    }
  };
  const beginWaiting = (scope = currentScope()) => {
    const target = validScope(scope);
    if (!target || disposed || acceptedScope === target) return target;
    if (waitingScope === target) return target;
    clearRecoveryTimer();
    waitingScope = target;
    recoveryScope = null;
    const delay = firstWait && !installedAtDocumentStart ? lateGraceMs : scopeGraceMs;
    firstWait = false;
    recoveryTimer = global.setTimeout(() => {
      recoveryTimer = null;
      if (disposed || acceptedScope === target || waitingScope !== target) return;
      recoveryScope = target;
      notify('recovery-needed', target);
    }, delay);
    return target;
  };

  const lifecycle = {
    currentScope,
    state(scope = currentScope()) {
      const target = validScope(scope);
      if (target && acceptedScope === target) return 'ready';
      beginWaiting(target);
      return target && recoveryScope === target ? 'reload-needed' : 'pending';
    },
    beginWaiting,
    accept(scope = currentScope()) {
      const target = validScope(scope);
      if (!target || target !== currentScope() || disposed) return false;
      acceptedScope = target;
      if (waitingScope === target) {
        waitingScope = null;
        recoveryScope = null;
        clearRecoveryTimer();
      }
      notify('snapshot-accepted', target);
      return true;
    },
    subscribe(listener) {
      if (typeof listener !== 'function' || disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reload() {
      global.location?.reload?.();
    },
    dispose() {
      disposed = true;
      clearRecoveryTimer();
      listeners.clear();
    }
  };
  return Object.freeze(lifecycle);
}
