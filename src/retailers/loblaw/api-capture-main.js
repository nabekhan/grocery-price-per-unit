/*!
 * Loblaw/PC Express page-world response observer. It watches search data the
 * storefront already requested and never sends a request itself. Query/store
 * scope, revision order, record breadth, strings, and numeric ranges are
 * validated before a bounded product snapshot reaches the DOM adapter.
 */
(function initializeLoblawApiCapture(global) {
  'use strict';

  const SOURCE = 'rcss-price-per-unit';
  const VERSION = 2;
  const PRODUCTS_TYPE = 'api-products';
  const REQUEST_TYPE = 'api-products-request';
  const INSTALL_KEY = typeof Symbol === 'function'
    ? Symbol.for('rcss-price-per-unit.api-capture.v1')
    : '__rcssPricePerUnitApiCaptureV1__';
  const SEARCH_PATH = /^\/pcx-bff\/api\/v\d+\/products\/search\/?$/i;
  const SUPPORTED_STOREFRONTS = new Set([
    'www.realcanadiansuperstore.ca',
    'www.nofrills.ca'
  ]);
  const MAX_PRODUCTS = 500;
  const MAX_COMPONENTS = 100;
  const MAX_INSPECTED_PRODUCT_TILES = 2_000;

  if (global[INSTALL_KEY]) return;
  const state = {
    products: {},
    productSequences: {},
    context: null,
    scope: null,
    revision: 0,
    requestSequence: 0,
    latestRequestScope: null,
    latestRequestSequence: 0
  };
  global[INSTALL_KEY] = state;

  function text(value, maximum = 1000) {
    if (typeof value !== 'string') return null;
    const cleaned = value.trim();
    return cleaned ? cleaned.slice(0, maximum) : null;
  }

  function number(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 && value <= 1_000_000 ? value : null;
    if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 1_000_000 ? parsed : null;
  }

  function normalizedQuery(value) {
    const query = text(value, 256);
    return query ? query.normalize('NFKC').replace(/\s+/g, ' ').toLowerCase() : null;
  }

  function pageContext(query, page = null, filterFingerprint = '') {
    const url = new URL(global.location.href);
    const context = {
      query: normalizedQuery(query || url.searchParams.get('search-bar')),
      storeId: text(url.searchParams.get('storeId'), 80),
      page: Number.isSafeInteger(page) && page >= 0 ? page : null,
      pagePath: `${url.pathname}${url.search}`.slice(0, 2048),
      filterFingerprint
    };
    const pageScope = context.query
      ? `query:${context.query}|store:${context.storeId || ''}`
      : `page:${context.pagePath}`;
    return { ...context, pageScope, scope: `${pageScope}|filter:${filterFingerprint}` };
  }

  function productTiles(payload) {
    const roots = [
      payload,
      payload?.initialSearchData,
      payload?.props?.pageProps?.initialSearchData,
      payload?.pageProps?.initialSearchData,
      payload?.data
    ].filter(Boolean);
    const tiles = [];
    const seen = new Set();
    let inspected = 0;
    for (const root of roots) {
      const components = root?.layout?.sections?.mainContentCollection?.components;
      if (!Array.isArray(components)) continue;
      for (const component of components.slice(0, MAX_COMPONENTS)) {
        const candidates = component?.data?.productTiles;
        if (!Array.isArray(candidates)) continue;
        const remaining = MAX_INSPECTED_PRODUCT_TILES - inspected;
        const limit = Math.min(candidates.length, remaining);
        for (let index = 0; index < limit; index += 1) {
          inspected += 1;
          const tile = candidates[index];
          if (!tile || typeof tile !== 'object' || seen.has(tile)) continue;
          seen.add(tile);
          tiles.push(tile);
          if (tiles.length >= MAX_PRODUCTS) return tiles;
        }
        if (inspected >= MAX_INSPECTED_PRODUCT_TILES) return tiles;
      }
    }
    return tiles;
  }

  function normalizeProduct(tile) {
    const id = text(tile?.productId || tile?.id, 160);
    const name = text(tile?.title || tile?.name, 1500);
    if (!id || !name || !/^[a-zA-Z0-9._:-]+$/.test(id)
      || id === '__proto__' || id === 'prototype' || id === 'constructor') return null;
    const pricing = tile?.pricing && typeof tile.pricing === 'object' ? tile.pricing : {};
    return {
      id,
      name,
      packageSizing: text(tile?.packageSizing, 256),
      currentPrice: number(pricing.price ?? pricing.currentPrice ?? pricing.salePrice),
      regularPrice: number(pricing.wasPrice ?? pricing.regularPrice ?? pricing.originalPrice),
      displayPrice: text(pricing.displayPrice, 80),
      weighted: typeof tile?.pricingUnits?.weighted === 'boolean' ? tile.pricingUnits.weighted : null
    };
  }

  function post(mode = 'snapshot') {
    if (!state.context) return;
    global.postMessage({
      source: SOURCE,
      version: VERSION,
      type: PRODUCTS_TYPE,
      mode,
      revision: state.revision,
      context: {
        query: state.context.query,
        storeId: state.context.storeId,
        page: state.context.page,
        pagePath: state.context.pagePath
      },
      products: Object.values(state.products)
    }, global.location.origin);
  }

  function canonicalValue(value, depth = 0, budget = { entries: 0 }) {
    if (budget.entries >= 200 || depth > 6) return null;
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') return value.slice(0, 256);
    if (Array.isArray(value)) {
      budget.entries += 1;
      return value.slice(0, 100).map((item) => canonicalValue(item, depth + 1, budget));
    }
    if (!value || typeof value !== 'object') return null;
    const result = {};
    for (const key of Object.keys(value).sort().slice(0, 100)) {
      budget.entries += 1;
      if (budget.entries > 200) break;
      result[key.slice(0, 128)] = canonicalValue(value[key], depth + 1, budget);
    }
    return result;
  }

  function filterFingerprint(urlValue, parsedBody) {
    const fingerprint = {};
    try {
      const url = new URL(urlValue, global.location.href);
      const params = {};
      for (const [key, value] of [...url.searchParams.entries()].sort()) {
        if (/^(?:search-bar|from|page|offset|skip)$/i.test(key)) continue;
        if (!params[key]) params[key] = [];
        params[key].push(value);
      }
      if (Object.keys(params).length) fingerprint.params = params;
    } catch { /* ignored */ }
    const listingInfo = parsedBody?.listingInfo;
    if (listingInfo && typeof listingInfo === 'object' && !Array.isArray(listingInfo)) {
      const listing = { ...listingInfo };
      delete listing.pagination;
      if (listing.filters && typeof listing.filters === 'object' && !Array.isArray(listing.filters)) {
        listing.filters = { ...listing.filters };
        delete listing.filters['search-bar'];
        if (!Object.keys(listing.filters).length) delete listing.filters;
      }
      if (Object.keys(listing).length) fingerprint.listingInfo = listing;
    }
    return Object.keys(fingerprint).length
      ? JSON.stringify(canonicalValue(fingerprint)).slice(0, 4096)
      : '';
  }

  function registerRequest(urlValue, body) {
    let parsedBody = null;
    if (typeof body === 'string' && body.length <= 200000) {
      try { parsedBody = JSON.parse(body); } catch { /* ignored */ }
    }
    let urlQuery = null;
    let urlPage = null;
    try {
      const url = new URL(urlValue, global.location.href);
      urlQuery = url.searchParams.get('search-bar');
      for (const key of ['from', 'page', 'offset', 'skip']) {
        const raw = url.searchParams.get(key);
        if (raw === null) continue;
        const candidate = Number(raw);
        if (Number.isSafeInteger(candidate) && candidate >= 0) { urlPage = candidate; break; }
      }
    } catch { /* ignored */ }
    const query = parsedBody?.listingInfo?.filters?.['search-bar']?.[0]
      || parsedBody?.searchRelatedInfo?.term || urlQuery;
    const bodyPage = parsedBody?.listingInfo?.pagination?.from;
    const page = Number.isSafeInteger(bodyPage) && bodyPage >= 0 ? bodyPage : urlPage;
    const context = pageContext(query, page, filterFingerprint(urlValue, parsedBody));
    context.requestSequence = ++state.requestSequence;
    if (!(Number.isSafeInteger(context.page) && context.page > 0)) {
      state.latestRequestScope = context.scope;
      state.latestRequestSequence = context.requestSequence;
    }
    return context;
  }

  function isActiveRequest(context) {
    if (context.requestSequence === 0) return state.latestRequestSequence === 0;
    const isLaterPage = Number.isSafeInteger(context.page) && context.page > 0;
    if (isLaterPage) {
      if (state.latestRequestScope) return context.scope === state.latestRequestScope
        && context.requestSequence > state.latestRequestSequence;
      return !state.scope || context.scope === state.scope;
    }
    return context.scope === state.latestRequestScope
      && context.requestSequence >= state.latestRequestSequence;
  }

  function useScope(context) {
    if (state.scope === context.scope) return;
    state.products = {};
    state.productSequences = {};
    state.scope = context.scope;
  }

  function ingest(payload, requestContext = null, { authoritative = false } = {}) {
    const context = requestContext?.scope
      ? requestContext
      : { ...pageContext(payload?.searchTermSubmitted || payload?.searchTerm), requestSequence: 0 };
    if (!isActiveRequest(context)) return false;
    const tiles = productTiles(payload);
    const products = {};
    for (const tile of tiles) {
      const product = normalizeProduct(tile);
      if (product) products[product.id] = product;
    }
    const isLaterPage = Number.isSafeInteger(context.page) && context.page > 0;
    const entries = Object.entries(products);
    if (!entries.length && (!authoritative || isLaterPage)) return false;
    useScope(context);
    if (!isLaterPage) {
      const laterProducts = Object.fromEntries(Object.entries(state.products).filter(([id]) =>
        (state.productSequences[id] || 0) > context.requestSequence));
      const laterSequences = Object.fromEntries(Object.entries(state.productSequences).filter(([, sequence]) =>
        sequence > context.requestSequence));
      state.products = laterProducts;
      state.productSequences = laterSequences;
    }
    for (const [id, product] of entries) {
      if ((state.productSequences[id] || 0) > context.requestSequence) continue;
      state.products[id] = product;
      state.productSequences[id] = context.requestSequence;
    }
    const keptIds = Object.keys(state.products).slice(-MAX_PRODUCTS);
    state.products = Object.fromEntries(keptIds.map((id) => [id, state.products[id]]));
    state.productSequences = Object.fromEntries(keptIds.map((id) => [id, state.productSequences[id]]));
    state.context = context;
    state.revision += 1;
    post('snapshot');
    return true;
  }

  function isSearchUrl(value) {
    try {
      const url = new URL(value, global.location.href);
      const pcSearch = url.hostname === 'api.pcexpress.ca' && SEARCH_PATH.test(url.pathname);
      const nextSearch = SUPPORTED_STOREFRONTS.has(url.hostname)
        && /^\/_next\/data\/[^/]+\/(?:en\/)?search\.json$/i.test(url.pathname);
      return pcSearch || nextSearch;
    } catch {
      return false;
    }
  }

  const nativeFetch = global.fetch;
  if (typeof nativeFetch === 'function') {
    global.fetch = function observedFetch(...args) {
      const request = args[0];
      const url = typeof request === 'string' || request instanceof URL ? String(request) : request?.url;
      const responsePromise = nativeFetch.apply(this, args);
      if (isSearchUrl(url)) {
        const body = args[1]?.body ?? request?.body;
        const context = registerRequest(url, body);
        responsePromise.then((response) => {
          const contentType = response?.headers?.get?.('content-type') || '';
          if (!response?.ok || !/\bjson\b/i.test(contentType) || (response.url && !isSearchUrl(response.url))) return;
          response.clone().json().then((payload) => ingest(payload, context, { authoritative: true })).catch(() => {});
        }, () => {});
      }
      return responsePromise;
    };
  }

  const xhr = global.XMLHttpRequest?.prototype;
  if (xhr) {
    const nativeOpen = xhr.open;
    const nativeSend = xhr.send;
    const requestUrls = new WeakMap();
    xhr.open = function observedOpen(method, url, ...args) {
      if (isSearchUrl(url)) requestUrls.set(this, String(url));
      else requestUrls.delete(this);
      return nativeOpen.call(this, method, url, ...args);
    };
    xhr.send = function observedSend(body) {
      const requestUrl = requestUrls.get(this);
      if (requestUrl) {
        const context = registerRequest(requestUrl, body);
        this.addEventListener('load', () => {
          const contentType = this.getResponseHeader?.('content-type') || '';
          if (this.status < 200 || this.status >= 300 || !/\bjson\b/i.test(contentType)
            || (this.responseURL && !isSearchUrl(this.responseURL))) return;
          try {
            const payload = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
            ingest(payload, context, { authoritative: true });
          } catch { /* ignored */ }
        }, { once: true });
      }
      return nativeSend.call(this, body);
    };
  }

  function readNextData() {
    const element = global.document?.getElementById('__NEXT_DATA__');
    if (!element?.textContent || element.textContent.length > 10000000) return false;
    try { return ingest(JSON.parse(element.textContent), null, { authoritative: true }); } catch { return false; }
  }

  function observeNextData() {
    if (readNextData()) return;
    const root = global.document?.documentElement;
    if (!root) {
      global.addEventListener('DOMContentLoaded', readNextData, { once: true });
      return;
    }
    const observer = new MutationObserver(() => {
      if (readNextData()) observer.disconnect();
    });
    observer.observe(root, { childList: true, subtree: true });
    global.addEventListener('DOMContentLoaded', () => { readNextData(); observer.disconnect(); }, { once: true });
  }
  observeNextData();

  global.addEventListener('message', (event) => {
    if (event.source !== global || event.origin !== global.location.origin) return;
    const message = event.data;
    if (message?.source === SOURCE && message?.version === VERSION && message?.type === REQUEST_TYPE) post();
  });
})(window);
