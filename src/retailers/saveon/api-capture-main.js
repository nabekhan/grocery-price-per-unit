/*!
 * Save-On-Foods page-world response observer. It accepts only Storefront
 * Gateway GET search responses matching the current query, pickup store,
 * filter, and request sequence. Bootstrap/first/later-page records are bounded
 * and sanitized; this observer never initiates a retailer request.
 */
export function installSaveOnCapture(global = window) {
  const SOURCE = 'saveon-price-per-unit';
  const VERSION = 2;
  const MAX_CAPTURED_PRODUCTS = 500;
  const MAX_WALK_NODES = 5000;
  const MAX_CONTAINER_ENTRIES = 500;
  const INSTALL_KEY = Symbol.for('saveon-price-per-unit.api-capture.v1');
  if (global[INSTALL_KEY]) return false;
  const state = {
    products: {},
    productSequences: {},
    revision: 0,
    requestSequence: 0,
    scope: null,
    pageScope: null,
    activeContext: null,
    latestRequestScope: null,
    latestRequestSequence: 0,
    preloadedRead: false,
    verifiedSnapshot: false
  };
  global[INSTALL_KEY] = state;

  const text = (value, maximum = 1000) => typeof value === 'string' && value.trim() ? value.trim().slice(0, maximum) : null;
  const number = (value) => {
    let parsed = value;
    if (typeof value === 'string') {
      const match = text(value, 80)?.replace(/,/g, '').match(/^\$?\s*(\d+(?:\.\d+)?)$/);
      parsed = match ? Number(match[1]) : NaN;
    }
    return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 && parsed <= 1_000_000_000
      ? parsed
      : null;
  };
  const price = (value) => {
    const parsed = number(value);
    return parsed !== null && parsed > 0 && parsed <= 1_000_000 ? parsed : null;
  };
  const unitPrice = (value) => {
    const raw = text(value, 160);
    if (!raw) return null;
    // Save-On represents per-item prices as "$0.36 each", while its mass
    // and volume values normally include a slash. Normalize the API field
    // before it crosses the bridge so the shared parser stays strict.
    return raw.replace(/^(\$\s*\d+(?:[.,]\d+)?)\s+(ea|each)$/i, '$1/$2');
  };
  const normalizedQuery = (value) => text(value, 256)?.normalize('NFKC').replace(/\s+/g, ' ').toLowerCase() || null;

  function pageContext() {
    // A document can be torn down while the short bootstrap poll is pending.
    // Safari normally retains Location until teardown completes, but treating a
    // missing URL as an inactive page keeps that lifecycle edge fail-closed.
    if (!global.location?.href) return null;
    const url = new URL(global.location.href);
    const currentQuery = normalizedQuery(url.searchParams.get('q'));
    const storeMatch = url.pathname.match(/\/rsid\/([^/]+)\/results\/?$/i);
    const storeId = storeMatch ? text(decodeURIComponent(storeMatch[1]), 80) : null;
    if (!currentQuery || !storeId) return null;
    const pagePath = `${url.pathname}${url.search}`.slice(0, 2048);
    const scope = `${url.pathname.replace(/\/$/, '')}?q=${encodeURIComponent(currentQuery)}`;
    return {
      query: currentQuery,
      storeId,
      pagePath,
      scope,
      pageScope: scope
    };
  }
  const documentInitialScope = pageContext()?.scope || null;

  function defaultFilterContext(context) {
    return context ? { ...context, scope: `${context.scope}|filter:`, filterFingerprint: '' } : null;
  }

  function searchUrl(value) {
    try {
      const url = new URL(String(value || ''), global.location.href);
      if (url.hostname.toLowerCase() !== 'storefrontgateway.saveonfoods.com') return null;
      if (!/^\/api\/stores\/[^/]+\/search\/?$/i.test(url.pathname)) return null;
      return url;
    } catch {
      return null;
    }
  }

  function endpointStoreId(url) {
    const match = url?.pathname?.match(/^\/api\/stores\/([^/]+)\/search\/?$/i);
    return match ? text(decodeURIComponent(match[1]), 80) : null;
  }

  function requestFingerprint(url) {
    const pagination = new Set(['from', 'limit', 'offset', 'page', 'pagesize', 'skip', 'take']);
    const parameters = [...url.searchParams.entries()]
      .filter(([key]) => key.toLowerCase() !== 'q' && !pagination.has(key.toLowerCase()))
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
    return parameters.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
  }

  function requestContext(value, method = 'GET') {
    try {
      if (String(method || 'GET').toUpperCase() !== 'GET') return null;
      const url = searchUrl(value);
      if (!url) return null;
      const requestedQuery = normalizedQuery(url.searchParams.get('q'));
      const current = pageContext();
      const storeId = endpointStoreId(url);
      if (!requestedQuery || !current || requestedQuery !== current.query || !storeId || storeId !== current.storeId) return null;
      const sequence = ++state.requestSequence;
      const filterFingerprint = requestFingerprint(url);
      const pageValues = ['from', 'offset', 'page', 'skip']
        .map((key) => Number(url.searchParams.get(key)))
        .filter((value) => Number.isSafeInteger(value) && value > 0);
      const context = {
        ...current,
        scope: `${current.scope}|filter:${filterFingerprint}`,
        filterFingerprint,
        sequence,
        isLaterPage: pageValues.length > 0
      };
      if (!context.isLaterPage) {
        state.latestRequestScope = context.scope;
        state.latestRequestSequence = sequence;
      }
      return context;
    } catch {
      return null;
    }
  }

  function isActive(context) {
    if (!context || pageContext()?.scope !== context.pageScope) return false;
    if (!context.sequence) return state.latestRequestSequence === 0;
    if (context.isLaterPage) {
      if (state.latestRequestScope) return context.scope === state.latestRequestScope
        && context.sequence > state.latestRequestSequence;
      return !state.scope || context.scope === state.scope;
    }
    return context.scope === state.latestRequestScope && context.sequence >= state.latestRequestSequence;
  }

  function useScope(context) {
    if (state.scope === context.scope) return;
    state.scope = context.scope;
    state.pageScope = context.pageScope;
    state.activeContext = context;
    state.products = {};
    state.productSequences = {};
    state.verifiedSnapshot = false;
  }

  function sanitize(raw) {
    const id = text(raw?.sku || raw?.productId, 160);
    const name = text(raw?.name, 1500);
    if (!id || !name || !/^[a-zA-Z0-9._:-]+$/.test(id)
      || id === '__proto__' || id === 'prototype' || id === 'constructor') return null;
    const size = raw.unitOfSize && typeof raw.unitOfSize === 'object' ? {
      size: number(raw.unitOfSize.size),
      abbreviation: text(raw.unitOfSize.abbreviation, 32),
      type: text(raw.unitOfSize.type, 64)
    } : null;
    return {
      id,
      name,
      currentPrice: price(raw.priceNumeric ?? raw.wholePrice ?? raw.price),
      unitPrice: unitPrice(raw.unitPrice || raw.pricePerUnit),
      unitOfSize: size?.size && (size.abbreviation || size.type) ? size : null,
      // Preserve only an explicit negative availability signal. Absent fields
      // are not inferred, keeping existing storefront records compatible.
      available: raw.available === false || raw.isAvailable === false ? false : true,
      sellBy: text(raw.sellBy, 40)
    };
  }

  function post(context, mode = 'snapshot') {
    if (!isActive(context) || state.scope !== context.scope) return;
    global.postMessage({
      source: SOURCE,
      version: VERSION,
      type: 'api-products',
      mode,
      revision: ++state.revision,
      context: { query: context.query, storeId: context.storeId, pagePath: context.pagePath },
      products: Object.values(state.products)
    }, global.location.origin);
  }

  function ingestProducts(values, context = pageContext(), { authoritative = false } = {}) {
    if (!Array.isArray(values) || !isActive(context)) return false;
    const next = {};
    for (const value of values.slice(0, MAX_CAPTURED_PRODUCTS)) {
      const product = sanitize(value);
      if (!product) continue;
      const sequence = Number(context.sequence) || 0;
      if (sequence >= (state.productSequences[product.id] || 0)) {
        next[product.id] = product;
      }
    }
    const entries = Object.entries(next);
    if (!entries.length && (!authoritative || context.isLaterPage)) return false;
    useScope(context);
    const sequence = Number(context.sequence) || 0;
    if (!context.isLaterPage) {
      const laterProducts = Object.fromEntries(Object.entries(state.products).filter(([id]) =>
        (state.productSequences[id] || 0) > sequence));
      const laterSequences = Object.fromEntries(Object.entries(state.productSequences).filter(([, value]) => value > sequence));
      state.products = laterProducts;
      state.productSequences = laterSequences;
    }
    for (const [id, product] of entries) {
      if ((state.productSequences[id] || 0) > sequence) continue;
      state.products[id] = product;
      state.productSequences[id] = sequence;
    }
    const keptIds = Object.keys(state.products).slice(-MAX_CAPTURED_PRODUCTS);
    state.products = Object.fromEntries(keptIds.map((id) => [id, state.products[id]]));
    state.productSequences = Object.fromEntries(keptIds.map((id) => [id, state.productSequences[id]]));
    state.activeContext = context;
    state.verifiedSnapshot = true;
    post(context, 'snapshot');
    return true;
  }

  function readPreloaded() {
    const context = pageContext();
    if (!context || state.preloadedRead || context.scope !== documentInitialScope) return false;
    const search = global.__PRELOADED_STATE__?.search;
    const ids = search?.products?.searchResults;
    const dictionary = search?.productCardDictionary;
    if (!Array.isArray(ids) || !dictionary || typeof dictionary !== 'object') return false;
    const values = [];
    for (let index = 0; index < Math.min(ids.length, MAX_CAPTURED_PRODUCTS); index += 1) {
      const value = dictionary[ids[index]];
      if (value) values.push(value);
    }
    const ingested = ingestProducts(values, {
      ...defaultFilterContext(context),
      sequence: 0,
      isLaterPage: false
    }, { authoritative: true });
    if (ingested) state.preloadedRead = true;
    return ingested;
  }

  function findProductArrays(root) {
    const found = [];
    const seen = new WeakSet();
    const pending = [{ value: root, depth: 0 }];
    let pendingIndex = 0;
    let enqueued = 1;
    let examined = 0;
    const productLike = (value) => value && typeof value === 'object' && !Array.isArray(value)
      && (value.sku || value.productId) && value.name && (value.unitPrice || value.pricePerUnit || value.unitOfSize);
    const enqueue = (value, depth) => {
      if (!value || typeof value !== 'object' || enqueued >= MAX_WALK_NODES) return;
      pending.push({ value, depth });
      enqueued += 1;
    };
    while (pendingIndex < pending.length && examined < MAX_WALK_NODES
      && found.length < MAX_CAPTURED_PRODUCTS) {
      const { value, depth } = pending[pendingIndex];
      pendingIndex += 1;
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      examined += 1;
      if (productLike(value)) {
        found.push(value);
        continue;
      }
      if (depth >= 8) continue;
      if (Array.isArray(value)) {
        const limit = Math.min(value.length, MAX_CONTAINER_ENTRIES);
        for (let index = 0; index < limit && enqueued < MAX_WALK_NODES; index += 1) {
          enqueue(value[index], depth + 1);
        }
        continue;
      }
      let visited = 0;
      for (const key in value) {
        if (visited >= MAX_CONTAINER_ENTRIES || enqueued >= MAX_WALK_NODES) break;
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        visited += 1;
        enqueue(value[key], depth + 1);
      }
    }
    return found;
  }

  function inspectResponse(response, context) {
    if (!isActive(context) || response?.ok === false) return;
    const finalUrl = response?.url ? searchUrl(response.url) : null;
    if (response?.url && (!finalUrl || normalizedQuery(finalUrl.searchParams.get('q')) !== context.query
      || endpointStoreId(finalUrl) !== context.storeId || requestFingerprint(finalUrl) !== context.filterFingerprint)) return;
    const contentType = response?.headers?.get?.('content-type');
    if (contentType && !/\bjson\b/i.test(contentType)) return;
    response.clone().json().then((payload) => {
      if (isActive(context)) ingestProducts(findProductArrays(payload), context, { authoritative: true });
    }).catch(() => {});
  }

  if (global.fetch) {
    const nativeFetch = global.fetch;
    global.fetch = function observedFetch(...args) {
      const input = args[0];
      const context = requestContext(input?.url || input, args[1]?.method || input?.method);
      const pending = nativeFetch.apply(this, args);
      if (context) pending.then((response) => inspectResponse(response, context), () => {});
      return pending;
    };
  }

  const xhr = global.XMLHttpRequest?.prototype;
  if (xhr) {
    const nativeOpen = xhr.open;
    const nativeSend = xhr.send;
    const requestContexts = new WeakMap();
    xhr.open = function observedOpen(method, url, ...args) {
      const context = requestContext(url, method);
      if (context) requestContexts.set(this, context);
      else requestContexts.delete(this);
      return nativeOpen.call(this, method, url, ...args);
    };
    xhr.send = function observedSend(body) {
      const context = requestContexts.get(this);
      if (context) {
        this.addEventListener('load', () => {
          try {
            if (typeof this.status === 'number' && this.status !== 0 && (this.status < 200 || this.status >= 300)) return;
            const finalUrl = this.responseURL ? searchUrl(this.responseURL) : null;
            if (this.responseURL && (!finalUrl || normalizedQuery(finalUrl.searchParams.get('q')) !== context.query
              || endpointStoreId(finalUrl) !== context.storeId || requestFingerprint(finalUrl) !== context.filterFingerprint)) return;
            const contentType = this.getResponseHeader?.('content-type');
            if (contentType && !/\bjson\b/i.test(contentType)) return;
            if (isActive(context)) ingestProducts(findProductArrays(JSON.parse(this.responseText)), context, { authoritative: true });
          } catch { /* ignored */ }
        }, { once: true });
      }
      return nativeSend.call(this, body);
    };
  }

  let attempts = 0;
  let timer = null;
  const stopPreloadedRetry = () => {
    if (timer === null) return;
    global.clearInterval(timer);
    timer = null;
  };
  const retryPreloaded = () => {
    attempts += 1;
    if (readPreloaded() || attempts >= 100) stopPreloadedRetry();
  };
  timer = global.setInterval(retryPreloaded, 50);
  global.addEventListener('DOMContentLoaded', () => {
    if (readPreloaded()) stopPreloadedRetry();
  }, { once: true });
  // The retry exists only to catch initial bootstrap state. It has no useful
  // work after navigation/BFCache handoff and must not outlive this page.
  global.addEventListener('pagehide', stopPreloadedRetry, { once: true });
  global.addEventListener('message', (event) => {
    if (event.source !== global || event.origin !== global.location.origin) return;
    if (event.data?.source === SOURCE && event.data?.version === VERSION && event.data?.type === 'api-products-request') {
      if (!readPreloaded()) {
        const context = defaultFilterContext(pageContext());
        if (context) {
          if (state.pageScope === context.pageScope && state.activeContext && state.verifiedSnapshot) post(state.activeContext);
          else {
            const initialContext = { ...context, sequence: 0, isLaterPage: false };
            useScope(initialContext);
          }
        }
      }
    }
  });
  return true;
}
