/*!
 * Loblaw/PC Express page-world response observer. It watches search data the
 * storefront already requested and never sends a request itself. Query/store
 * scope, revision order, record breadth, strings, and numeric ranges are
 * validated before a bounded product snapshot reaches the DOM adapter.
 */
export function installLoblawCapture(global = window) {
  const SOURCE = 'rcss-price-per-unit';
  const VERSION = 2;
  const PRODUCTS_TYPE = 'api-products';
  const REQUEST_TYPE = 'api-products-request';
  const INSTALL_KEY = typeof Symbol === 'function'
    ? Symbol.for('rcss-price-per-unit.api-capture.v1')
    : '__rcssPricePerUnitApiCaptureV1__';
  const SEARCH_PATH = /^\/pcx-bff\/api\/v\d+\/products\/search\/?$/i;
  const TYPEAHEAD_PATH = /^\/pcx-bff\/api\/v(\d+)\/products\/type-ahead\/?$/i;
  const CART_PATH = /^\/pcx-bff\/api\/v\d+\/carts\/([^/?#]+)\/?$/i;
  const CUSTOMER_CARTS_PATH = /^\/pcx-bff\/api\/v(\d+)\/customers\/[^/?#]+\/carts\/?$/i;
  // PC Express's browser key is a public client identifier shipped in its web
  // application, not a private account credential. Account/session material is
  // read only from this page's cookies and never crosses the module closure.
  const PCX_PUBLIC_WEB_KEY = 'C1xujSegT5j3ap3yexJjqhOfELwGKYvz';
  const SITE_BANNERS = Object.freeze({
    'www.realcanadiansuperstore.ca': 'superstore',
    'www.nofrills.ca': 'nofrills'
  });
  const SUPPORTED_STOREFRONTS = new Set([
    'www.realcanadiansuperstore.ca',
    'www.nofrills.ca'
  ]);
  const MAX_PRODUCTS = 500;
  const MAX_COMPONENTS = 100;
  const MAX_INSPECTED_PRODUCT_TILES = 2_000;
  const BOOTSTRAP_IDENTITY_GRACE_MS = 5_000;

  if (global[INSTALL_KEY]) return false;
  const state = {
    products: {},
    productSequences: {},
    context: null,
    scope: null,
    revision: 0,
    requestSequence: 0,
    latestRequestScope: null,
    latestRequestSequence: 0,
    // This enum contains no request, header, cookie, cart, or customer data.
    // It exists only so a live Safari run can explain why the guarded direct
    // cart capability is or is not ready without exposing its private template.
    cartCapabilityStatus: 'waiting',
    installedAt: Date.now(),
    initialHistoryLength: Number.isSafeInteger(global.history?.length) ? global.history.length : null
  };
  global[INSTALL_KEY] = state;

  // This value is intentionally not part of `state`: state is exposed only so
  // the content-world bridge can read sanitized product facts. A captured
  // request can contain short-lived auth material, so it stays in this lexical
  // closure and is handed directly to the retailer runtime by the plugin host.
  let searchTemplate = null;
  let cartTemplate = null;
  let nextBuildId = null;
  let cartProbeInFlight = false;
  let lastCartProbeAt = 0;
  // These are captured before the storefront can replace browser primitives.
  // In particular, never reconstruct auth-bearing headers with window.Headers.
  const NativeHeaders = global.Headers;

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

  function payloadQuery(payload) {
    const roots = [
      payload,
      payload?.initialSearchData,
      payload?.props?.pageProps?.initialSearchData,
      payload?.pageProps?.initialSearchData,
      payload?.data
    ];
    for (const root of roots) {
      const query = root?.searchTermSubmitted || root?.searchTerm;
      if (normalizedQuery(query)) return query;
    }
    return null;
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

  function isPcxSearchUrl(value) {
    try {
      const url = new URL(value, global.location.href);
      return url.hostname === 'api.pcexpress.ca' && SEARCH_PATH.test(url.pathname);
    } catch {
      return false;
    }
  }

  function jsonBody(body) {
    if (typeof body !== 'string' || body.length < 2 || body.length > 200000) return null;
    try {
      const parsed = JSON.parse(body);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function hasKnownSearchField(body) {
    return Array.isArray(body?.listingInfo?.filters?.['search-bar'])
      || typeof body?.searchRelatedInfo?.term === 'string'
      || typeof body?.term === 'string';
  }

  function clonedHeaders(headers) {
    try { return new NativeHeaders(headers); } catch { return null; }
  }

  function rememberSearchTemplate(urlValue, request, init, body) {
    if (!isPcxSearchUrl(urlValue) || typeof body !== 'string') return;
    const parsed = jsonBody(body);
    if (!parsed || !hasKnownSearchField(parsed)) return;
    const method = String(init?.method || request?.method || 'GET').toUpperCase();
    if (method !== 'POST') return;
    const baseHeaders = clonedHeaders(request?.headers);
    const initHeaders = clonedHeaders(init?.headers);
    if (init?.headers && !initHeaders) return;
    if (!baseHeaders && request?.headers) return;
    if (baseHeaders && initHeaders) initHeaders.forEach((value, key) => baseHeaders.set(key, value));
    const headers = baseHeaders || initHeaders || clonedHeaders();
    if (!headers) return;
    try {
      const url = new URL(urlValue, global.location.href);
      searchTemplate = Object.freeze({
        url: url.href,
        headers,
        credentials: init?.credentials || request?.credentials || 'same-origin',
        mode: init?.mode || request?.mode,
        redirect: init?.redirect || request?.redirect,
        referrer: init?.referrer || request?.referrer,
        referrerPolicy: init?.referrerPolicy || request?.referrerPolicy,
        cache: init?.cache || request?.cache,
        integrity: init?.integrity || request?.integrity,
        body
      });
      const cartProbe = cartProbeFromSearchTemplate(searchTemplate);
      if (cartProbe) void probeCustomerCart(cartProbe);
    } catch { /* an invalid observed request cannot become a template */ }
  }

  function cartProbeFromSearchTemplate(template) {
    const storeId = currentStoreId();
    const cartId = currentCartId();
    if (!template || !storeId || !cartId) return null;
    try {
      const searchUrl = new URL(template.url);
      if (searchUrl.hostname !== 'api.pcexpress.ca') return null;
      const url = new URL(`/pcx-bff/api/v1/carts/${encodeURIComponent(cartId)}`, searchUrl.origin);
      state.cartCapabilityStatus = 'search-cart-observed';
      return Object.freeze({
        url: url.href, cartId, storeId, headers: template.headers,
        credentials: template.credentials, mode: template.mode,
        redirect: template.redirect, referrer: template.referrer,
        referrerPolicy: template.referrerPolicy, cache: template.cache
      });
    } catch { return null; }
  }

  function cookieValue(name, maximum = 4_096) {
    try {
      const prefix = `${name}=`;
      const pair = String(global.document?.cookie || '').split(';').map((part) => part.trim())
        .find((part) => part.startsWith(prefix));
      if (!pair) return null;
      const value = decodeURIComponent(pair.slice(prefix.length));
      return value && value.length <= maximum ? value : null;
    } catch { return null; }
  }

  function publicCartHeaders() {
    const banner = SITE_BANNERS[global.location.hostname];
    if (!banner || !NativeHeaders) return null;
    const token = cookieValue('AccessToken');
    const headers = new NativeHeaders({
      accept: 'application/json, text/plain, */*',
      'accept-language': 'en',
      basesiteid: banner,
      'site-banner': banner,
      'business-user-agent': 'PCXWEB',
      'content-type': 'application/json',
      'is-helios-account': token ? 'true' : 'false',
      'is-iceberg-enabled': 'true',
      'x-apikey': PCX_PUBLIC_WEB_KEY,
      'x-application-type': 'web',
      'x-channel': 'web',
      'x-loblaw-tenant-id': 'ONLINE_GROCERIES'
    });
    if (token) headers.set('authorization', `bearer ${token}`);
    return headers;
  }

  function cartProbeFromPageSession() {
    const storeId = currentStoreId();
    const cartId = currentCartId();
    const headers = publicCartHeaders();
    if (!storeId || !cartId || !headers) return null;
    try {
      const url = new URL(`/pcx-bff/api/v1/carts/${encodeURIComponent(cartId)}`, 'https://api.pcexpress.ca');
      state.cartCapabilityStatus = 'page-session-observed';
      return Object.freeze({
        url: url.href, cartId, storeId, headers, credentials: 'include',
        mode: 'cors', redirect: 'follow', referrer: global.location.href,
        referrerPolicy: 'strict-origin-when-cross-origin', cache: 'no-store'
      });
    } catch { return null; }
  }

  function bootstrapCartFromPageSession() {
    if (state.cartCapabilityStatus === 'ready') return;
    const probe = cartProbeFromPageSession();
    if (probe) void probeCustomerCart(probe);
  }

  function observedTypeaheadCartProbe(urlValue, request, init) {
    const storeId = currentStoreId();
    const cartId = currentCartId();
    if (!storeId || !cartId) return null;
    try {
      const observedUrl = new URL(urlValue, global.location.href);
      if (observedUrl.hostname !== 'api.pcexpress.ca') return null;
      const match = TYPEAHEAD_PATH.exec(observedUrl.pathname);
      if (!match) return null;
      const method = String(init?.method || request?.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'POST') return null;
      const baseHeaders = clonedHeaders(request?.headers);
      const initHeaders = clonedHeaders(init?.headers);
      if (init?.headers && !initHeaders) return null;
      if (!baseHeaders && request?.headers) return null;
      if (baseHeaders && initHeaders) initHeaders.forEach((value, key) => baseHeaders.set(key, value));
      const headers = baseHeaders || initHeaders || clonedHeaders();
      if (!headers) return null;
      const directUrl = new URL(`/pcx-bff/api/v${match[1]}/carts/${encodeURIComponent(cartId)}`, observedUrl.origin);
      state.cartCapabilityStatus = 'typeahead-cart-observed';
      return Object.freeze({
        url: directUrl.href, cartId, storeId, headers,
        credentials: init?.credentials || request?.credentials || 'same-origin',
        mode: init?.mode || request?.mode, redirect: init?.redirect || request?.redirect,
        referrer: init?.referrer || request?.referrer, referrerPolicy: init?.referrerPolicy || request?.referrerPolicy,
        cache: init?.cache || request?.cache
      });
    } catch { return null; }
  }

  function resetPagination(target) {
    if (!target || typeof target !== 'object' || Array.isArray(target)) return;
    // PCX `page` is not consistently zero-based.  Reset only offset-style
    // fields whose meaning is unambiguous, retaining any page contract.
    for (const key of ['from', 'offset', 'skip']) {
      if (Object.hasOwn(target, key)) target[key] = 0;
    }
  }

  function rewriteSearchTemplate(template, query) {
    const body = jsonBody(template?.body);
    const nextQuery = normalizedQuery(query);
    if (!body || !nextQuery) return null;
    let rewritten = false;
    const filters = body?.listingInfo?.filters;
    if (filters && typeof filters === 'object' && !Array.isArray(filters)
      && Array.isArray(filters['search-bar'])) {
      // A Cart Builder query must not inherit a visible brand, deal, or other
      // listing filter: those silently exclude the cheapest result.  Store and
      // banner context live outside `filters` and remain untouched.
      body.listingInfo.filters = { 'search-bar': [nextQuery] };
      resetPagination(body.listingInfo?.pagination);
      rewritten = true;
    }
    if (body?.searchRelatedInfo && typeof body.searchRelatedInfo === 'object'
      && !Array.isArray(body.searchRelatedInfo) && typeof body.searchRelatedInfo.term === 'string') {
      body.searchRelatedInfo.term = nextQuery;
      resetPagination(body.searchRelatedInfo.pagination);
      rewritten = true;
    }
    if (typeof body.term === 'string') {
      body.term = nextQuery;
      resetPagination(body.pagination);
      rewritten = true;
    }
    if (!rewritten) return null;
    let url;
    try {
      url = new URL(template.url);
      for (const key of ['from', 'offset', 'skip']) {
        if (url.searchParams.has(key)) url.searchParams.set(key, '0');
      }
    } catch {
      return null;
    }
    return { url: url.href, body: JSON.stringify(body) };
  }

  function currentStoreId() {
    try {
      return text(new URL(global.location.href).searchParams.get('storeId'), 80)
        || text(cookieValue('last_selected_store', 80), 80);
    } catch { return text(cookieValue('last_selected_store', 80), 80); }
  }

  function currentCartId() {
    const validCartId = (value) => {
      const cartId = text(value, 160);
      return cartId && /^[A-Za-z0-9._:-]+$/.test(cartId) ? cartId : null;
    };
    try {
      const fromUrl = validCartId(new URL(global.location.href).searchParams.get('cartId'));
      if (fromUrl) return fromUrl;
    } catch { /* fall through to the storefront's same-origin storage */ }
    try {
      const exact = validCartId(global.localStorage?.getItem('lcl-cart-id-banner'))
        || validCartId(global.localStorage?.getItem('ANONYMOUS_CART_ID'));
      if (exact) return exact;
      // Loblaw has renamed its cart key before. Keep the fallback both bounded
      // and semantically narrow; arbitrary localStorage values are never read.
      const maximum = Math.min(Number(global.localStorage?.length) || 0, 100);
      for (let index = 0; index < maximum; index += 1) {
        const key = global.localStorage.key(index);
        if (!key || !/cart.?id/i.test(key)) continue;
        const candidate = validCartId(global.localStorage.getItem(key));
        if (candidate) return candidate;
      }
    } catch { /* storage may be disabled */ }
    return null;
  }

  function nextSearchUrl(query) {
    const storeId = currentStoreId();
    if (!nextBuildId || !storeId) return null;
    try {
      const url = new URL(`/_next/data/${encodeURIComponent(nextBuildId)}/en/search.json`, global.location.origin);
      url.searchParams.set('search-bar', normalizedQuery(query));
      url.searchParams.set('storeId', storeId);
      return url.href;
    } catch { return null; }
  }

  async function readSearchResponse(response, expectedQuery) {
    const contentType = response?.headers?.get?.('content-type') || '';
    if (!response?.ok || !/\bjson\b/i.test(contentType)) return null;
    const payload = await response.json();
    if (normalizedQuery(payloadQuery(payload)) !== normalizedQuery(expectedQuery)) return null;
    const products = [];
    const seen = new Set();
    for (const tile of productTiles(payload)) {
      const product = normalizeProduct(tile);
      if (!product || seen.has(product.id)) continue;
      seen.add(product.id);
      products.push(product);
    }
    return Object.freeze({ status: 'complete', products: Object.freeze(products) });
  }

  async function queryNextProducts(query) {
    const url = nextSearchUrl(query);
    if (!url || typeof nativeFetch !== 'function') return null;
    const controller = typeof global.AbortController === 'function' ? new global.AbortController() : null;
    const timeout = controller ? global.setTimeout(() => controller.abort(), 12_000) : null;
    try {
      const response = await nativeFetch.call(global, url, {
        method: 'GET', credentials: 'same-origin', ...(controller ? { signal: controller.signal } : {})
      });
      return await readSearchResponse(response, query);
    } catch { return null; } finally { if (timeout !== null) global.clearTimeout(timeout); }
  }

  async function queryProducts(query) {
    // Next's data endpoint is a direct, same-origin, read-only representation
    // of the initial search page. Prefer it: it has no active UI filters and
    // needs neither a prior XHR template nor a rendered product grid.
    const nextResult = await queryNextProducts(query);
    if (nextResult) return nextResult;
    const rewritten = rewriteSearchTemplate(searchTemplate, query);
    if (!rewritten || typeof nativeFetch !== 'function') return null;
    const controller = typeof global.AbortController === 'function' ? new global.AbortController() : null;
    const timeout = controller ? global.setTimeout(() => controller.abort(), 12_000) : null;
    try {
      const template = searchTemplate;
      // Copy rather than expose the captured Headers object. This request is
      // made in the same page world and browser session as the original,
      // preserving retailer-selected store and authentication context.
      const response = await nativeFetch.call(global, rewritten.url, {
        method: 'POST', body: rewritten.body, headers: new NativeHeaders(template.headers),
        credentials: template.credentials,
        ...(template.mode ? { mode: template.mode } : {}),
        ...(template.redirect ? { redirect: template.redirect } : {}),
        ...(template.referrer ? { referrer: template.referrer } : {}),
        ...(template.referrerPolicy ? { referrerPolicy: template.referrerPolicy } : {}),
        ...(template.cache ? { cache: template.cache } : {}),
        ...(template.integrity ? { integrity: template.integrity } : {}),
        ...(controller ? { signal: controller.signal } : {})
      });
      if (response.url && !isPcxSearchUrl(response.url)) return null;
      return await readSearchResponse(response, query);
    } catch {
      return null;
    } finally {
      if (timeout !== null) global.clearTimeout(timeout);
    }
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
      : { ...pageContext(payloadQuery(payload)), requestSequence: 0 };
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

  function refineBootstrapStoreIdentity() {
    const previous = state.context;
    if (!previous || previous.requestSequence !== 0 || previous.storeId
      || state.latestRequestSequence !== 0 || !previous.query
      || Date.now() - state.installedAt > BOOTSTRAP_IDENTITY_GRACE_MS
      || (state.initialHistoryLength !== null && global.history?.length !== state.initialHistoryLength)) return false;
    let currentQuery = null;
    try {
      currentQuery = normalizedQuery(new URL(global.location.href).searchParams.get('search-bar'));
    } catch { /* rejected below */ }
    if (currentQuery !== previous.query) return false;
    const next = { ...pageContext(currentQuery), requestSequence: 0 };
    if (!next.storeId) return false;
    try {
      const previousPath = new URL(previous.pagePath, global.location.origin).pathname;
      const currentPath = new URL(next.pagePath, global.location.origin).pathname;
      if (previousPath !== currentPath) return false;
    } catch {
      return false;
    }

    /*
     * Superstore currently renders its trusted __NEXT_DATA__ while the initial
     * URL contains only the query, then completes the same document's identity
     * by adding storeId with history.replaceState. Preserve that already-
     * sanitized bootstrap only for this one-way identity completion. A changed
     * query, path, known store, observed API request, elapsed startup grace, or
     * pushed history entry can never be relabelled.
     */
    state.context = next;
    state.scope = next.scope;
    state.revision += 1;
    post('snapshot');
    return true;
  }

  function isSearchUrl(value) {
    try {
      const url = new URL(value, global.location.href);
      const pcSearch = isPcxSearchUrl(url.href);
      const nextSearch = SUPPORTED_STOREFRONTS.has(url.hostname)
        && /^\/_next\/data\/[^/]+\/(?:en\/)?search\.json$/i.test(url.pathname);
      return pcSearch || nextSearch;
    } catch {
      return false;
    }
  }

  function cartRequestDetails(value) {
    try {
      const url = new URL(value, global.location.href);
      if (url.hostname !== 'api.pcexpress.ca') return null;
      const match = CART_PATH.exec(url.pathname);
      if (!match || !/^[A-Za-z0-9._:-]{1,160}$/.test(match[1])) return null;
      return { url, cartId: match[1] };
    } catch { return null; }
  }

  function observedCartTemplate(urlValue, request, init) {
    const details = cartRequestDetails(urlValue);
    const storeId = currentStoreId();
    const cartId = currentCartId();
    if (!details || !storeId || !cartId || details.cartId !== cartId) return null;
    const method = String(init?.method || request?.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') return null;
    const baseHeaders = clonedHeaders(request?.headers);
    const initHeaders = clonedHeaders(init?.headers);
    if (init?.headers && !initHeaders) return null;
    if (!baseHeaders && request?.headers) return null;
    if (baseHeaders && initHeaders) initHeaders.forEach((value, key) => baseHeaders.set(key, value));
    const headers = baseHeaders || initHeaders || clonedHeaders();
    if (!headers) return null;
    state.cartCapabilityStatus = 'direct-cart-observed';
    return Object.freeze({
      url: details.url.href, cartId: details.cartId, storeId, headers,
      credentials: init?.credentials || request?.credentials || 'same-origin',
      mode: init?.mode || request?.mode, redirect: init?.redirect || request?.redirect,
      referrer: init?.referrer || request?.referrer, referrerPolicy: init?.referrerPolicy || request?.referrerPolicy,
      cache: init?.cache || request?.cache, integrity: init?.integrity || request?.integrity
    });
  }

  function cartEntry(payload, productId) {
    const roots = [payload, payload?.cart, payload?.data].filter((value) => value && typeof value === 'object');
    for (const root of roots) {
      const entry = root.entries?.[productId];
      const quantity = Number(entry?.quantity);
      if (entry && Number.isFinite(quantity) && quantity >= 1) return entry;
      for (const order of Array.isArray(root.orders) ? root.orders.slice(0, 20) : []) {
        for (const orderedEntry of Array.isArray(order?.entries) ? order.entries.slice(0, 500) : []) {
          const offer = orderedEntry?.offer;
          const code = offer?.id ?? offer?.product?.code ?? offer?.product?.id;
          const orderedQuantity = Number(orderedEntry?.quantity ?? orderedEntry?.qty);
          if (String(code || '') === productId && Number.isFinite(orderedQuantity) && orderedQuantity >= 1) {
            return orderedEntry;
          }
        }
      }
    }
    return null;
  }

  function cartContextMatches(payload, storeId) {
    // An empty PC Express cart has no entry-level fulfillmentMethod/sellerId,
    // which made Superstore impossible to bootstrap before the first Add. A
    // successful exact-cart GET is still usable when it has a recognized cart
    // shape and the store came from the current URL/cookie. If the payload does
    // expose store identities, at least one must match; a mismatch always
    // fails closed.
    const roots = [payload, payload?.cart, payload?.data]
      .filter((value) => value && typeof value === 'object' && !Array.isArray(value));
    const shaped = roots.some((root) => Array.isArray(root.orders)
      || (root.entries && typeof root.entries === 'object' && !Array.isArray(root.entries)));
    if (!shaped) return false;
    const seen = new Set();
    const storeIds = new Set();
    const walk = (value, depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 7 || seen.has(value)) return;
      seen.add(value);
      for (const [key, child] of Object.entries(value).slice(0, 100)) {
        if (/^(?:sellerId|storeId|fulfillmentStoreId)$/i.test(key)
          && (typeof child === 'string' || typeof child === 'number') && String(child)) {
          storeIds.add(String(child));
        } else if (child && typeof child === 'object') {
          walk(child, depth + 1);
        }
      }
    };
    walk(payload);
    return storeIds.size === 0 || storeIds.has(String(storeId));
  }

  async function observeCartResponse(template, response) {
    if (!template) return;
    if (!response?.ok) {
      state.cartCapabilityStatus = 'current-cart-request-failed';
      return;
    }
    const contentType = response.headers?.get?.('content-type') || '';
    if (!/\bjson\b/i.test(contentType)) {
      state.cartCapabilityStatus = 'current-cart-not-json';
      return;
    }
    try {
      const payload = await response.clone().json();
      if (!acceptCartTemplate(template, payload)) state.cartCapabilityStatus = 'current-cart-unverified';
    } catch {
      state.cartCapabilityStatus = 'current-cart-unreadable';
    }
  }

  function observedCustomerCartProbe(urlValue, request, init) {
    const storeId = currentStoreId();
    const cartId = currentCartId();
    if (!storeId || !cartId) return null;
    try {
      const observedUrl = new URL(urlValue, global.location.href);
      if (observedUrl.hostname !== 'api.pcexpress.ca') return null;
      const match = CUSTOMER_CARTS_PATH.exec(observedUrl.pathname);
      if (!match) return null;
      const method = String(init?.method || request?.method || 'GET').toUpperCase();
      if (method !== 'GET') return null;
      const baseHeaders = clonedHeaders(request?.headers);
      const initHeaders = clonedHeaders(init?.headers);
      if (init?.headers && !initHeaders) return null;
      if (!baseHeaders && request?.headers) return null;
      if (baseHeaders && initHeaders) initHeaders.forEach((value, key) => baseHeaders.set(key, value));
      const headers = baseHeaders || initHeaders || clonedHeaders();
      if (!headers) return null;
      const directUrl = new URL(`/pcx-bff/api/v${match[1]}/carts/${encodeURIComponent(cartId)}`, observedUrl.origin);
      state.cartCapabilityStatus = 'customer-cart-observed';
      return Object.freeze({
        url: directUrl.href, cartId, storeId, headers,
        credentials: init?.credentials || request?.credentials || 'same-origin',
        mode: init?.mode || request?.mode, redirect: init?.redirect || request?.redirect,
        referrer: init?.referrer || request?.referrer, referrerPolicy: init?.referrerPolicy || request?.referrerPolicy,
        cache: init?.cache || request?.cache
      });
    } catch { return null; }
  }

  async function probeCustomerCart(template) {
    if (!template || template.storeId !== currentStoreId() || template.cartId !== currentCartId()
      || typeof nativeFetch !== 'function' || cartProbeInFlight
      || Date.now() - lastCartProbeAt < 2_000) return;
    cartProbeInFlight = true;
    lastCartProbeAt = Date.now();
    const controller = typeof global.AbortController === 'function' ? new global.AbortController() : null;
    const timeout = controller ? global.setTimeout(() => controller.abort(), 12_000) : null;
    try {
      state.cartCapabilityStatus = 'verifying-current-cart';
      // The customer-carts XHR supplies the same authenticated PCX headers,
      // while this exact-cart read supplies the pickup/store proof. No
      // customer identifier or response body is exposed outside the closure.
      const response = await nativeFetch.call(global, template.url,
        cartRequestOptions(template, 'GET', null, controller?.signal));
      await observeCartResponse(template, response);
      if (state.cartCapabilityStatus !== 'ready') state.cartCapabilityStatus = 'current-cart-unverified';
    } catch {
      state.cartCapabilityStatus = 'current-cart-unavailable';
    } finally {
      if (timeout !== null) global.clearTimeout(timeout);
      cartProbeInFlight = false;
    }
  }

  async function observeCustomerCartResponse(template, response) {
    if (!template || !response?.ok) return;
    const contentType = response.headers?.get?.('content-type') || '';
    if (!/\bjson\b/i.test(contentType)) return;
    try {
      const payload = await response.clone().json();
      if (!payload || typeof payload !== 'object') return;
      await probeCustomerCart(template);
    } catch { /* malformed list replies never trigger the exact-cart probe */ }
  }

  function acceptCartTemplate(template, payload) {
    if (!template || !payload || typeof payload !== 'object') return false;
    // We retain a template only after a recognized response to the exact cart
    // request agrees with any store identity it contains. Loblaw currently
    // uses XMLHttpRequest for these calls on No Frills and fetch on some other
    // storefront builds, so both observers feed this one gate.
    if (!cartContextMatches(payload, template.storeId)) return false;
    cartTemplate = template;
    state.cartCapabilityStatus = 'ready';
    return true;
  }

  function cartRequestOptions(template, method, body, signal = null) {
    const headers = new NativeHeaders(template.headers);
    if (body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    return {
      method, headers, credentials: template.credentials,
      ...(body ? { body } : {}), ...(template.mode ? { mode: template.mode } : {}),
      ...(template.redirect ? { redirect: template.redirect } : {}), ...(template.referrer ? { referrer: template.referrer } : {}),
      ...(template.referrerPolicy ? { referrerPolicy: template.referrerPolicy } : {}),
      ...(template.cache ? { cache: template.cache } : {}), ...(template.integrity ? { integrity: template.integrity } : {}),
      ...(signal ? { signal } : {})
    };
  }

  async function readCart(productIds = []) {
    const template = cartTemplate;
    if (!template || template.storeId !== currentStoreId() || template.cartId !== currentCartId()
      || typeof nativeFetch !== 'function') return null;
    const controller = typeof global.AbortController === 'function' ? new global.AbortController() : null;
    const timeout = controller ? global.setTimeout(() => controller.abort(), 12_000) : null;
    try {
      const response = await nativeFetch.call(global, template.url, cartRequestOptions(template, 'GET', null, controller?.signal));
      const contentType = response?.headers?.get?.('content-type') || '';
      if (!response?.ok || !/\bjson\b/i.test(contentType)) return null;
      const payload = await response.json();
      if (!cartContextMatches(payload, template.storeId)) return null;
      const presentProductIds = productIds.filter((id) => typeof id === 'string' && cartEntry(payload, id));
      return Object.freeze({ inspectable: true, presentProductIds: Object.freeze(presentProductIds) });
    } catch { return null; } finally { if (timeout !== null) global.clearTimeout(timeout); }
  }

  async function addProduct(productId) {
    const template = cartTemplate;
    if (!template || template.storeId !== currentStoreId() || template.cartId !== currentCartId()
      || !/^[A-Za-z0-9._:-]{1,160}$/.test(productId || '')
      || typeof nativeFetch !== 'function') return null;
    const controller = typeof global.AbortController === 'function' ? new global.AbortController() : null;
    const timeout = controller ? global.setTimeout(() => controller.abort(), 12_000) : null;
    try {
      const body = JSON.stringify({ entries: { [productId]: {
        quantity: 1, fulfillmentMethod: 'pickup', sellerId: template.storeId
      } } });
      const response = await nativeFetch.call(global, template.url,
        cartRequestOptions(template, 'POST', body, controller?.signal));
      const contentType = response?.headers?.get?.('content-type') || '';
      if (!response?.ok || !/\bjson\b/i.test(contentType)) return null;
      const payload = await response.json();
      if (cartContextMatches(payload, template.storeId) && cartEntry(payload, productId)) {
        return Object.freeze({ status: 'added' });
      }
      const verified = await readCart([productId]);
      return verified?.presentProductIds.includes(productId) ? Object.freeze({ status: 'added' }) : null;
    } catch { return null; } finally { if (timeout !== null) global.clearTimeout(timeout); }
  }

  const nativeFetch = global.fetch;
  if (typeof nativeFetch === 'function') {
    global.fetch = function observedFetch(...args) {
      const request = args[0];
      const url = typeof request === 'string' || request instanceof URL ? String(request) : request?.url;
      const responsePromise = nativeFetch.apply(this, args);
      const cart = observedCartTemplate(url, request, args[1]);
      const customerCart = observedCustomerCartProbe(url, request, args[1]);
      const typeaheadCart = observedTypeaheadCartProbe(url, request, args[1]);
      if (cart) responsePromise.then((response) => { void observeCartResponse(cart, response); }, () => {});
      if (customerCart) responsePromise.then((response) => {
        void observeCustomerCartResponse(customerCart, response);
      }, () => {});
      if (typeaheadCart) void probeCustomerCart(typeaheadCart);
      if (isSearchUrl(url)) {
        const body = args[1]?.body ?? request?.body;
        rememberSearchTemplate(url, request, args[1], body);
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
    const requestMethods = new WeakMap();
    const requestHeaders = new WeakMap();
    xhr.open = function observedOpen(method, url, ...args) {
      if (isSearchUrl(url) || cartRequestDetails(url) || (() => {
        try { return TYPEAHEAD_PATH.test(new URL(url, global.location.href).pathname); } catch { return false; }
      })() || (() => {
        try { return CUSTOMER_CARTS_PATH.test(new URL(url, global.location.href).pathname); } catch { return false; }
      })()) {
        requestUrls.set(this, String(url));
        requestMethods.set(this, String(method || 'GET').toUpperCase());
        requestHeaders.set(this, []);
      } else {
        requestUrls.delete(this);
        requestMethods.delete(this);
        requestHeaders.delete(this);
      }
      return nativeOpen.call(this, method, url, ...args);
    };
    const nativeSetRequestHeader = xhr.setRequestHeader;
    if (typeof nativeSetRequestHeader === 'function') {
      xhr.setRequestHeader = function observedSetRequestHeader(name, value) {
        const headers = requestHeaders.get(this);
        if (headers && typeof name === 'string' && typeof value === 'string') headers.push([name, value]);
        return nativeSetRequestHeader.call(this, name, value);
      };
    }
    xhr.send = function observedSend(body) {
      const requestUrl = requestUrls.get(this);
      if (requestUrl) {
        const method = requestMethods.get(this);
        const headers = requestHeaders.get(this);
        const options = {
          method, headers, credentials: this.withCredentials ? 'include' : 'same-origin'
        };
        const cart = observedCartTemplate(requestUrl, { method, headers }, options);
        const customerCart = observedCustomerCartProbe(requestUrl, { method, headers }, options);
        const typeaheadCart = observedTypeaheadCartProbe(requestUrl, { method, headers }, options);
        if (cart) {
          this.addEventListener('load', () => {
            const contentType = this.getResponseHeader?.('content-type') || '';
            if (this.status < 200 || this.status >= 300 || !/\bjson\b/i.test(contentType)
              || (this.responseURL && !cartRequestDetails(this.responseURL))) return;
            try {
              const payload = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
              acceptCartTemplate(cart, payload);
            } catch { /* malformed cart replies never enable direct mutation */ }
          }, { once: true });
        }
        if (customerCart) {
          this.addEventListener('load', () => {
            const contentType = this.getResponseHeader?.('content-type') || '';
            if (this.status < 200 || this.status >= 300 || !/\bjson\b/i.test(contentType)) return;
            try {
              const payload = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
              if (payload && typeof payload === 'object') void probeCustomerCart(customerCart);
            } catch { /* malformed list replies never trigger the exact-cart probe */ }
          }, { once: true });
        }
        if (typeaheadCart) void probeCustomerCart(typeaheadCart);
        if (isSearchUrl(requestUrl)) {
          rememberSearchTemplate(requestUrl, { method, headers }, options, body);
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
      }
      return nativeSend.call(this, body);
    };
  }

  function readNextData() {
    const element = global.document?.getElementById('__NEXT_DATA__');
    if (!element?.textContent || element.textContent.length > 10000000) return false;
    try {
      const payload = JSON.parse(element.textContent);
      const buildId = text(payload?.buildId, 160);
      if (buildId && /^[A-Za-z0-9_-]+$/.test(buildId)) nextBuildId = buildId;
      return ingest(payload, null, { authoritative: true });
    } catch { return false; }
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

  // Userscripts for Safari can arrive after the storefront's startup cart
  // request. PC Express also persists the active cart and pickup store in this
  // same page origin, so bootstrap directly and verify the exact cart with a
  // read-only GET. Short retries cover the site's initial identity hydration;
  // failed reads never enable mutation and never trigger a page reload.
  bootstrapCartFromPageSession();
  global.setTimeout(bootstrapCartFromPageSession, 250);
  global.setTimeout(bootstrapCartFromPageSession, 1_500);

  global.addEventListener('message', (event) => {
    if (event.source !== global || event.origin !== global.location.origin) return;
    const message = event.data;
    if (message?.source === SOURCE && message?.version === VERSION && message?.type === REQUEST_TYPE
      && !refineBootstrapStoreIdentity()) {
      bootstrapCartFromPageSession();
      post();
    }
  });
  return Object.freeze({ queryProducts, addProduct, readCart });
}
