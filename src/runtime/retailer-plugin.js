import { createRetailerLifecycle } from './retailer-lifecycle.js';

/*!
 * Formal retailer-plugin boundary.
 *
 * A plugin owns retailer-specific capture and DOM behavior. This host router
 * owns only exact-host selection and deterministic phase ordering: capture is
 * installed synchronously before the product/UI runtime. Keeping the contract
 * lexical (rather than a page-global registry) prevents retailer code from
 * replacing an adapter after the userscript has selected it.
 */

const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export function defineRetailerPlugin({ id, hostnames, isSearchPage, getScope, installCapture, installRuntime }) {
  if (!ID_PATTERN.test(id || '')) throw new TypeError('Retailer plugin id must be a stable lowercase identifier');
  if (!Array.isArray(hostnames) || !hostnames.length || hostnames.some((host) => !HOST_PATTERN.test(host))) {
    throw new TypeError(`Retailer plugin ${id} must declare exact hostnames`);
  }
  if (new Set(hostnames).size !== hostnames.length) throw new TypeError(`Retailer plugin ${id} repeats a hostname`);
  if (typeof isSearchPage !== 'function' || typeof getScope !== 'function'
    || typeof installCapture !== 'function' || typeof installRuntime !== 'function') {
    throw new TypeError(`Retailer plugin ${id} must implement search-page, scope, capture, and runtime contracts`);
  }
  return Object.freeze({
    id,
    hostnames: Object.freeze([...hostnames]),
    isSearchPage,
    getScope,
    installCapture,
    installRuntime
  });
}

export function installRetailerPlugin(plugin, global = globalThis) {
  const hostname = String(global.location?.hostname || '').toLowerCase();
  if (!plugin.hostnames.includes(hostname)) return Object.freeze({ matched: false, id: plugin.id });
  const context = Object.freeze({
    id: plugin.id,
    hostname,
    installedAtDocumentStart: global.document?.readyState === 'loading',
    // Page eligibility is deliberately retailer-owned. The shared host/runtime
    // can suspend work consistently without learning any retailer URL shape.
    isSearchPage: () => {
      try { return plugin.isSearchPage(new URL(global.location?.href)); } catch { return false; }
    },
    lifecycle: createRetailerLifecycle({
      global,
      id: plugin.id,
      getScope: plugin.getScope,
      installedAtDocumentStart: global.document?.readyState === 'loading'
    })
  });
  // Capture must be first. A response that occurs between these phases remains
  // replayable through the plugin's bounded snapshot channel when UI subscribes.
  /*
   * Capture may return a small lexical capability in addition to signalling
   * installation.  It is deliberately passed directly to the runtime rather
   * than attached to window: request templates can include authentication
   * headers and must never become page-observable state.
   */
  const capture = plugin.installCapture(global, context);
  const captureInstalled = capture !== false;
  const runtimeInstalled = plugin.installRuntime(global, context, capture) !== false;
  return Object.freeze({ matched: true, id: plugin.id, captureInstalled, runtimeInstalled });
}
