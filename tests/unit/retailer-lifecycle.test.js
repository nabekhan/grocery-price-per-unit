import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureWaitState, createRetailerLifecycle, createScanScheduler } from '../../src/runtime/retailer-lifecycle.js';

function platform(reload = vi.fn()) {
  return {
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback) => setTimeout(callback, 16),
    cancelAnimationFrame: clearTimeout,
    location: { reload }
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('shared retailer capture lifecycle', () => {
  it('keeps non-capture safety waits pending even after a snapshot is ready', () => {
    const lifecycle = createRetailerLifecycle({
      global: platform(), id: 'fixture', getScope: () => 'scope', installedAtDocumentStart: true
    });
    expect(captureWaitState(lifecycle)).toBe('pending');
    lifecycle.accept('scope');
    expect(lifecycle.state()).toBe('ready');
    expect(captureWaitState(lifecycle)).toBe('pending');
  });

  it('turns a late-injection wait into an actionable state without reloading automatically', () => {
    let scope = 'query:milk|store:1';
    const reload = vi.fn();
    const lifecycle = createRetailerLifecycle({
      global: platform(reload),
      id: 'fixture',
      getScope: () => scope,
      installedAtDocumentStart: false,
      lateGraceMs: 100,
      scopeGraceMs: 500
    });
    const events = [];
    lifecycle.subscribe((event) => events.push(event));

    expect(lifecycle.state()).toBe('pending');
    vi.advanceTimersByTime(99);
    expect(lifecycle.state()).toBe('pending');
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(lifecycle.state()).toBe('reload-needed');
    expect(events).toContainEqual({ reason: 'recovery-needed', scope });
    expect(reload).not.toHaveBeenCalled();

    lifecycle.reload();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('invalidates an accepted scope and recovers immediately when matching data arrives', () => {
    let scope = 'query:milk|store:1';
    const lifecycle = createRetailerLifecycle({
      global: platform(), id: 'fixture', getScope: () => scope,
      installedAtDocumentStart: true, lateGraceMs: 100, scopeGraceMs: 500
    });
    const events = [];
    lifecycle.subscribe((event) => events.push(event));

    expect(lifecycle.accept(scope)).toBe(true);
    expect(lifecycle.state()).toBe('ready');
    scope = 'query:milk|store:2';
    expect(lifecycle.state()).toBe('pending');
    vi.advanceTimersByTime(500);
    expect(lifecycle.state()).toBe('reload-needed');
    expect(lifecycle.accept(scope)).toBe(true);
    expect(lifecycle.state()).toBe('ready');
    expect(events.at(-1)).toEqual({ reason: 'snapshot-accepted', scope });
  });

  it('never accepts a stale snapshot for a different current scope', () => {
    let scope = 'query:milk|store:2';
    const lifecycle = createRetailerLifecycle({
      global: platform(), id: 'fixture', getScope: () => scope,
      installedAtDocumentStart: true, scopeGraceMs: 100
    });

    expect(lifecycle.accept('query:milk|store:1')).toBe(false);
    expect(lifecycle.state()).toBe('pending');
    scope = 'query:eggs|store:2';
    expect(lifecycle.accept('query:milk|store:2')).toBe(false);
    expect(lifecycle.state()).toBe('pending');
  });

  it('isolates listeners and stops all transitions after disposal', () => {
    const lifecycle = createRetailerLifecycle({
      global: platform(), id: 'fixture', getScope: () => 'scope',
      installedAtDocumentStart: false, lateGraceMs: 10
    });
    const healthy = vi.fn();
    lifecycle.subscribe(() => { throw new Error('listener failure'); });
    lifecycle.subscribe(healthy);
    lifecycle.state();
    lifecycle.dispose();
    vi.runAllTimers();
    expect(healthy).not.toHaveBeenCalled();
    expect(lifecycle.accept('scope')).toBe(false);
  });
});

describe('shared retailer scan scheduler', () => {
  it('promotes a pending debounce to the next animation frame for accepted data', () => {
    const scan = vi.fn();
    const schedule = createScanScheduler(platform(), scan, { delayMs: 180 });
    expect(schedule()).toBe(true);
    vi.advanceTimersByTime(80);
    expect(schedule({ urgent: true })).toBe(true);
    expect(schedule({ urgent: true })).toBe(false);
    vi.advanceTimersByTime(15);
    expect(scan).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(scan).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(200);
    expect(scan).toHaveBeenCalledOnce();
  });

  it('does no work after disposal', () => {
    const scan = vi.fn();
    const schedule = createScanScheduler(platform(), scan);
    schedule();
    schedule.dispose();
    vi.runAllTimers();
    expect(scan).not.toHaveBeenCalled();
    expect(schedule()).toBe(false);
  });
});
