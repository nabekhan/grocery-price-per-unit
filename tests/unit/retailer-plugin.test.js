import { describe, expect, it, vi } from 'vitest';
import { defineRetailerPlugin, installRetailerPlugin } from '../../src/runtime/retailer-plugin.js';

function plugin(overrides = {}) {
  return defineRetailerPlugin({
    id: 'fixture',
    hostnames: ['shop.example.ca'],
    getScope: vi.fn(() => 'scope:fixture'),
    installCapture: vi.fn(() => true),
    installRuntime: vi.fn(() => true),
    ...overrides
  });
}

describe('formal retailer plugin contract', () => {
  it('installs capture synchronously before runtime on an exact host', () => {
    const order = [];
    const fixture = plugin({
      installCapture: vi.fn((_global, context) => order.push(['capture', context])),
      installRuntime: vi.fn((_global, context) => order.push(['runtime', context]))
    });
    const result = installRetailerPlugin(fixture, {
      location: { hostname: 'shop.example.ca' },
      document: { readyState: 'loading' }
    });

    expect(order.map(([phase]) => phase)).toEqual(['capture', 'runtime']);
    expect(order[0][1]).toMatchObject({ id: 'fixture', hostname: 'shop.example.ca', installedAtDocumentStart: true });
    expect(order[0][1].lifecycle.currentScope()).toBe('scope:fixture');
    expect(order[0][1]).toBe(order[1][1]);
    expect(Object.isFrozen(order[0][1])).toBe(true);
    expect(result).toEqual({ matched: true, id: 'fixture', captureInstalled: true, runtimeInstalled: true });
  });

  it('leaves every plugin phase inert on an unrelated or near-match host', () => {
    const fixture = plugin();
    expect(installRetailerPlugin(fixture, {
      location: { hostname: 'shop.example.ca.attacker.test' },
      document: { readyState: 'complete' }
    })).toEqual({ matched: false, id: 'fixture' });
    expect(fixture.installCapture).not.toHaveBeenCalled();
    expect(fixture.installRuntime).not.toHaveBeenCalled();
  });

  it.each([
    [{ id: 'Bad ID' }, 'stable lowercase identifier'],
    [{ hostnames: [] }, 'exact hostnames'],
    [{ hostnames: ['shop.example.ca', 'shop.example.ca'] }, 'repeats a hostname'],
    [{ getScope: null }, 'scope, capture, and runtime contracts'],
    [{ installCapture: null }, 'scope, capture, and runtime contracts'],
    [{ installRuntime: null }, 'scope, capture, and runtime contracts']
  ])('rejects an invalid contract: %j', (override, message) => {
    expect(() => plugin(override)).toThrow(message);
  });
});
