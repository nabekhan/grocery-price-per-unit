// Safari's manifest converter does not support content_scripts[].world. When
// this file starts in the isolated extension world, expose and inject the same
// file as a page script so it can observe RCSS's later Next.js fetches. The
// page-world copy has no extension runtime object and skips this bootstrap.
(function injectPageWorldCapture(global) {
  const runtime = global.browser?.runtime || global.chrome?.runtime;
  const root = global.document?.documentElement;
  if (!runtime?.getURL || !root || root.dataset.rcssApiCaptureInjected) return;
  root.dataset.rcssApiCaptureInjected = 'true';
  const script = global.document.createElement('script');
  script.src = runtime.getURL('loblaw-api-capture-main.js');
  script.async = false;
  script.dataset.rcssApiCapturePageScript = 'true';
  script.addEventListener('load', () => script.remove(), { once: true });
  script.addEventListener('error', () => {
    delete root.dataset.rcssApiCaptureInjected;
    script.remove();
  }, { once: true });
  root.prepend(script);
})(globalThis);

// Observes search data already loaded by supported Loblaw storefronts; it never
// sends a retailer request.
(function initializeLoblawApiCapture(global) {
  'use strict';

  const SOURCE = 'rcss-price-per-unit';
  const VERSION = 1;
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

  if (global[INSTALL_KEY]) return;
  const state = { products: {}, context: null, revision: 0, requestSequence: 0 };
  global[INSTALL_KEY] = state;

  function text(value, maximum = 1000) {
    if (typeof value !== 'string') return null;
    const cleaned = value.trim();
    return cleaned ? cleaned.slice(0, maximum) : null;
  }

  function number(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
    if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function normalizedQuery(value) {
    const query = text(value, 256);
    return query ? query.normalize('NFKC').replace(/\s+/g, ' ').toLowerCase() : null;
  }

  function pageContext(query, page = null) {
    const url = new URL(global.location.href);
    return {
      query: normalizedQuery(query || url.searchParams.get('search-bar')),
      storeId: text(url.searchParams.get('storeId'), 80),
      page: Number.isSafeInteger(page) && page >= 0 ? page : null,
      pagePath: `${url.pathname}${url.search}`.slice(0, 2048)
    };
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
    for (const root of roots) {
      const components = root?.layout?.sections?.mainContentCollection?.components;
      if (!Array.isArray(components)) continue;
      for (const component of components.slice(0, MAX_COMPONENTS)) {
        const candidates = component?.data?.productTiles;
        if (!Array.isArray(candidates)) continue;
        for (const tile of candidates) {
          if (!tile || typeof tile !== 'object' || seen.has(tile)) continue;
          seen.add(tile);
          tiles.push(tile);
          if (tiles.length >= MAX_PRODUCTS) return tiles;
        }
      }
    }
    return tiles;
  }

  function normalizeProduct(tile, requestSequence) {
    const id = text(tile?.productId || tile?.id, 160);
    const name = text(tile?.title || tile?.name, 1500);
    if (!id || !name || !/^[a-zA-Z0-9._:-]+$/.test(id)) return null;
    const pricing = tile?.pricing && typeof tile.pricing === 'object' ? tile.pricing : {};
    return {
      id,
      name,
      packageSizing: text(tile?.packageSizing, 256),
      currentPrice: number(pricing.price ?? pricing.currentPrice ?? pricing.salePrice),
      regularPrice: number(pricing.wasPrice ?? pricing.regularPrice ?? pricing.originalPrice),
      displayPrice: text(pricing.displayPrice, 80),
      weighted: typeof tile?.pricingUnits?.weighted === 'boolean' ? tile.pricingUnits.weighted : null,
      requestSequence
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
      context: state.context,
      products: state.products
    }, global.location.origin);
  }

  function contextScope(context) {
    return context?.query
      ? `query:${context.query}|store:${context.storeId || ''}`
      : `page:${context?.pagePath || ''}`;
  }

  function ingest(payload, requestContext = {}) {
    const tiles = productTiles(payload);
    if (!tiles.length) return false;
    const requestSequence = ++state.requestSequence;
    const products = {};
    for (const tile of tiles) {
      const product = normalizeProduct(tile, requestSequence);
      if (product) products[product.id] = product;
    }
    if (!Object.keys(products).length) return false;
    const context = pageContext(
      requestContext.query || payload?.searchTermSubmitted || payload?.searchTerm,
      requestContext.page
    );
    const isLaterPage = Number.isSafeInteger(context.page) && context.page > 0;
    const shouldMerge = isLaterPage && contextScope(context) === contextScope(state.context);
    const combined = shouldMerge ? { ...state.products, ...products } : products;
    state.products = Object.fromEntries(Object.entries(combined).slice(-MAX_PRODUCTS));
    state.context = context;
    state.revision += 1;
    post('snapshot');
    return true;
  }

  function contextFromRequest(urlValue, body) {
    let urlQuery = null;
    try { urlQuery = new URL(urlValue, global.location.href).searchParams.get('search-bar'); } catch { /* ignored */ }
    if (typeof body !== 'string' || body.length > 200000) return { query: urlQuery };
    try {
      const parsed = JSON.parse(body);
      const query = parsed?.listingInfo?.filters?.['search-bar']?.[0]
        || parsed?.searchRelatedInfo?.term || urlQuery;
      const from = parsed?.listingInfo?.pagination?.from;
      return { query, page: Number.isSafeInteger(from) ? from : null };
    } catch {
      return { query: urlQuery };
    }
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
    global.fetch = async function observedFetch(...args) {
      const response = await nativeFetch.apply(this, args);
      const request = args[0];
      const url = typeof request === 'string' || request instanceof URL ? String(request) : request?.url;
      if (isSearchUrl(url)) {
        const body = args[1]?.body ?? request?.body;
        response.clone().json().then((payload) => ingest(payload, contextFromRequest(url, body))).catch(() => {});
      }
      return response;
    };
  }

  const xhr = global.XMLHttpRequest?.prototype;
  if (xhr) {
    const nativeOpen = xhr.open;
    const nativeSend = xhr.send;
    xhr.open = function observedOpen(method, url, ...args) {
      this.__rcssSearchUrl = isSearchUrl(url) ? String(url) : null;
      return nativeOpen.call(this, method, url, ...args);
    };
    xhr.send = function observedSend(body) {
      if (this.__rcssSearchUrl) {
        const context = contextFromRequest(this.__rcssSearchUrl, body);
        this.addEventListener('load', () => {
          try { ingest(JSON.parse(this.responseText), context); } catch { /* ignored */ }
        }, { once: true });
      }
      return nativeSend.call(this, body);
    };
  }

  function readNextData() {
    const element = global.document.getElementById('__NEXT_DATA__');
    if (!element?.textContent || element.textContent.length > 10000000) return false;
    try { return ingest(JSON.parse(element.textContent)); } catch { return false; }
  }

  if (!readNextData()) {
    const observer = new MutationObserver(() => {
      if (readNextData()) observer.disconnect();
    });
    observer.observe(global.document.documentElement, { childList: true, subtree: true });
    global.addEventListener('DOMContentLoaded', () => { readNextData(); observer.disconnect(); }, { once: true });
  }

  global.addEventListener('message', (event) => {
    if (event.source !== global || event.origin !== global.location.origin) return;
    const message = event.data;
    if (message?.source === SOURCE && message?.version === VERSION && message?.type === REQUEST_TYPE) post();
  });
})(window);
