// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

const source = `${fs.readFileSync('src/retailers/loblaw/api-capture-main.js', 'utf8')
  .replace('export function installLoblawCapture', 'function installLoblawCapture')}\ninstallLoblawCapture(window);`;
const capabilitySource = `${fs.readFileSync('src/retailers/loblaw/api-capture-main.js', 'utf8')
  .replace('export function installLoblawCapture', 'function installLoblawCapture')}\nwindow.__gppuLoblawCapability = installLoblawCapture(window);`;
// jsdom's immutable location uses localhost. Add that test-only hostname to
// the production banner map so this one case can exercise the page-session
// bootstrap without weakening the runtime hostname allow-list.
const sessionCapabilitySource = capabilitySource.replace(
  "'www.nofrills.ca': 'nofrills'",
  "'www.nofrills.ca': 'nofrills', 'localhost': 'nofrills'"
);
const OriginalHeaders = window.Headers;
const OriginalXMLHttpRequest = window.XMLHttpRequest;

const payloadFor = (id, options = {}) => ({
  searchTermSubmitted: options.query || 'milk',
  layout: { sections: { mainContentCollection: { components: [{ data: { productTiles: [{
    productId: id,
    title: options.title || id,
    packageSizing: options.packageSizing || '1 l',
    pricing: { price: options.price || '4.00' }
  }] } }] } } }
});

const jsonResponse = (payload, options = {}) => new Response(JSON.stringify(payload), {
  status: options.status || 200,
  headers: { 'content-type': options.contentType || 'application/json' }
});

const searchRequest = (filter, from = null) => ({
  method: 'POST',
  body: JSON.stringify({
    listingInfo: {
      filters: { 'search-bar': ['milk'], ...(filter ? { brand: [filter] } : {}) },
      ...(from === null ? {} : { pagination: { from } })
    }
  })
});

beforeEach(() => {
  window.history.replaceState({}, '', '/en/search?search-bar=milk&storeId=fixture-store');
  document.documentElement.innerHTML = '<head></head><body></body>';
  window.localStorage.clear();
  document.cookie = 'fulfillment_pickup_type=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  delete window[Symbol.for('rcss-price-per-unit.api-capture.v1')];
  delete window.__gppuLoblawCapability;
  window.Headers = OriginalHeaders;
  window.XMLHttpRequest = OriginalXMLHttpRequest;
  window.fetch = vi.fn(async () => new Response('{}', { status: 200 }));
});

describe('RCSS main-world search capture', () => {
  it('replays a captured v2 search template for a new query without changing the current snapshot scope', async () => {
    const endpoint = 'https://api.pcexpress.ca/pcx-bff/api/v2/products/search?from=48';
    const original = JSON.stringify({
      listingInfo: {
        filters: { 'search-bar': ['milk'], brand: ['fixture'] },
        pagination: { from: 48, page: 2, offset: 96 }
      }
    });
    const calls = [];
    window.fetch = vi.fn(async (url, options) => {
      calls.push({ url, options });
      const body = JSON.parse(options.body);
      return jsonResponse(payloadFor(body.listingInfo.filters['search-bar'][0] === 'rice' ? 'rice_EA' : 'milk_EA', {
        query: body.listingInfo.filters['search-bar'][0]
      }));
    });
    window.eval(capabilitySource);

    await window.fetch(endpoint, { method: 'POST', headers: { 'x-fixture': 'yes' }, body: original });
    await vi.waitFor(() => expect(window[Symbol.for('rcss-price-per-unit.api-capture.v1')].context.query).toBe('milk'));
    const result = await window.__gppuLoblawCapability.queryProducts(' Rice ');

    expect(result).toMatchObject({ status: 'complete', products: [expect.objectContaining({ id: 'rice_EA' })] });
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain('from=0');
    expect(calls[1].options.headers.get('x-fixture')).toBe('yes');
    expect(JSON.parse(calls[1].options.body)).toMatchObject({
      listingInfo: { filters: { 'search-bar': ['rice'] }, pagination: { from: 0, page: 2, offset: 0 } }
    });
    // Direct previewing is read-only and must not relabel the live UI data.
    expect(window[Symbol.for('rcss-price-per-unit.api-capture.v1')].context.query).toBe('milk');
    expect(window[Symbol.for('rcss-price-per-unit.api-capture.v1')].products.rice_EA).toBeUndefined();
  });

  it('supports a v1 term body and resets only recognized pagination fields', async () => {
    const endpoint = 'https://api.pcexpress.ca/pcx-bff/api/v1/products/search';
    const calls = [];
    window.fetch = vi.fn(async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(payloadFor('rice_EA', { query: JSON.parse(options.body).term }));
    });
    window.eval(capabilitySource);

    await window.fetch(endpoint, {
      method: 'POST', body: JSON.stringify({ term: 'milk', pagination: { from: 25, skip: 25, size: 48 } })
    });
    const result = await window.__gppuLoblawCapability.queryProducts('rice');

    expect(result?.products[0]).toMatchObject({ id: 'rice_EA' });
    expect(JSON.parse(calls[1].options.body)).toMatchObject({
      term: 'rice', pagination: { from: 0, skip: 0, size: 48 }
    });
  });

  it('queries validated initial Next data first without a captured PCX request', async () => {
    document.body.innerHTML = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      buildId: 'fixture_build-1', props: { pageProps: { initialSearchData: payloadFor('milk_EA') } }
    })}</script>`;
    const calls = [];
    window.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      return jsonResponse({ props: { pageProps: { initialSearchData: payloadFor('bread_EA', { query: 'bread' }) } } });
    });
    window.eval(capabilitySource);
    const result = await window.__gppuLoblawCapability.queryProducts('bread');
    expect(result).toMatchObject({ status: 'complete', products: [expect.objectContaining({ id: 'bread_EA' })] });
    expect(calls).toEqual([expect.stringContaining('/_next/data/fixture_build-1/en/search.json?search-bar=bread&storeId=fixture-store')]);
  });

  it('uses native Headers for replay even if the page replaces window.Headers', async () => {
    const endpoint = 'https://api.pcexpress.ca/pcx-bff/api/v2/products/search';
    const calls = [];
    window.fetch = vi.fn(async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse(payloadFor('rice_EA', { query: JSON.parse(options.body).listingInfo.filters['search-bar'][0] }));
    });
    window.eval(capabilitySource);
    await window.fetch(endpoint, { method: 'POST', headers: { authorization: 'private-value' }, body: searchRequest(null).body });
    window.Headers = class ReplacedHeaders { constructor() { throw new Error('page replacement observed headers'); } };
    await expect(window.__gppuLoblawCapability.queryProducts('rice')).resolves.toMatchObject({ status: 'complete' });
    expect(calls[1].options.headers.get('authorization')).toBe('private-value');
  });

  it('verifies the current pickup cart with headers from the observed product search', async () => {
    window.history.replaceState({}, '', '/en/search?search-bar=milk&storeId=fixture-store&cartId=cart_fixture');
    document.cookie = 'fulfillment_pickup_type=store; path=/';
    const calls = [];
    window.fetch = vi.fn(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return String(url).includes('/carts/cart_fixture')
        ? jsonResponse({ entries: {} })
        : jsonResponse(payloadFor('milk_EA'));
    });
    window.eval(capabilitySource);

    await window.fetch('https://api.pcexpress.ca/pcx-bff/api/v2/products/search', {
      method: 'POST', headers: { authorization: 'private-value' }, body: searchRequest(null).body
    });

    await vi.waitFor(() => expect(window[Symbol.for('rcss-price-per-unit.api-capture.v1')].cartCapabilityStatus)
      .toBe('ready'));
    expect(calls.find((call) => call.url.includes('/carts/cart_fixture'))).toMatchObject({
      url: 'https://api.pcexpress.ca/pcx-bff/api/v1/carts/cart_fixture', options: { method: 'GET' }
    });
    expect(calls.find((call) => call.url.includes('/carts/cart_fixture')).options.headers.get('authorization'))
      .toBe('private-value');
  });

  it('recovers after late injection by verifying the cart with a later type-ahead request', async () => {
    window.history.replaceState({}, '', '/en/search?search-bar=milk&storeId=fixture-store&cartId=cart_fixture');
    document.cookie = 'fulfillment_pickup_type=store; path=/';
    const calls = [];
    window.fetch = vi.fn(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ entries: {} });
    });
    window.eval(capabilitySource);

    await window.fetch('https://api.pcexpress.ca/pcx-bff/api/v2/products/type-ahead?term=eggs', {
      method: 'GET', headers: { authorization: 'private-value' }, credentials: 'include'
    });

    await vi.waitFor(() => expect(window[Symbol.for('rcss-price-per-unit.api-capture.v1')].cartCapabilityStatus)
      .toBe('ready'));
    expect(calls[1]).toMatchObject({
      url: 'https://api.pcexpress.ca/pcx-bff/api/v2/carts/cart_fixture',
      options: { method: 'GET', credentials: 'include' }
    });
    expect(calls[1].options.headers.get('authorization')).toBe('private-value');
  });

  it('bootstraps a late Safari install from the current page cart and pickup-store identity', async () => {
    window.history.replaceState({}, '', '/en/search?search-bar=milk');
    window.localStorage.setItem('lcl-cart-id-banner', 'cart_fixture');
    document.cookie = 'last_selected_store=fixture-store; path=/';
    document.cookie = 'fulfillment_pickup_type=store; path=/';
    const calls = [];
    window.fetch = vi.fn(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ cart: { orders: [] } });
    });

    window.eval(sessionCapabilitySource);

    await vi.waitFor(() => expect(window[Symbol.for('rcss-price-per-unit.api-capture.v1')].cartCapabilityStatus)
      .toBe('ready'));
    expect(calls[0]).toMatchObject({
      url: 'https://api.pcexpress.ca/pcx-bff/api/v1/carts/cart_fixture',
      options: { method: 'GET', credentials: 'include' }
    });
    expect(calls[0].options.headers.get('basesiteid')).toBe('nofrills');
    expect(calls[0].options.headers.has('x-apikey')).toBe(true);
    expect(calls[0].options.headers.has('authorization')).toBe(false);
  });

  it('adds and reviews only through an observed pickup cart template, then verifies the exact entry', async () => {
    window.history.replaceState({}, '', '/en/search?search-bar=milk&storeId=fixture-store&cartId=cart_fixture');
    document.cookie = 'fulfillment_pickup_type=pickup; path=/';
    const cartUrl = 'https://api.pcexpress.ca/pcx-bff/api/v2/carts/cart_fixture';
    const payload = { cart: { orders: [{ entries: [{
      quantity: 1,
      offer: { id: 'milk_EA' }
    }] }] } };
    const calls = [];
    window.fetch = vi.fn(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return jsonResponse(payload);
    });
    window.eval(capabilitySource);
    await window.fetch(cartUrl, { method: 'GET', headers: { 'x-cart': 'yes' } });
    await vi.waitFor(async () => expect(await window.__gppuLoblawCapability.readCart(['milk_EA']))
      .toMatchObject({ inspectable: true, presentProductIds: ['milk_EA'] }));
    await expect(window.__gppuLoblawCapability.addProduct('milk_EA')).resolves.toEqual({ status: 'added' });
    expect(calls.at(-1)).toMatchObject({ url: cartUrl, options: { method: 'POST' } });
    expect(calls.at(-1).options.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(calls.at(-1).options.body)).toEqual({ entries: {
      milk_EA: { quantity: 1, fulfillmentMethod: 'pickup', sellerId: 'fixture-store' }
    } });
  });

  it('captures the authenticated No Frills cart template from XMLHttpRequest', async () => {
    window.history.replaceState({}, '', '/en/search?search-bar=milk&storeId=fixture-store&cartId=cart_fixture');
    const cartUrl = 'https://api.pcexpress.ca/pcx-bff/api/v1/carts/cart_fixture';
    const payload = { entries: { milk_EA: {
      quantity: 1, fulfillmentMethod: 'pickup', sellerId: 'fixture-store'
    } } };
    class FixtureXHR {
      constructor() { this.listeners = {}; this.responseType = ''; this.withCredentials = true; }
      open(method, url) { this.method = method; this.url = String(url); }
      setRequestHeader(name, value) { this.headers ||= []; this.headers.push([name, value]); }
      addEventListener(type, listener) { this.listeners[type] ||= []; this.listeners[type].push(listener); }
      getResponseHeader(name) { return String(name).toLowerCase() === 'content-type' ? 'application/json' : null; }
      send() {
        this.status = 200;
        this.responseURL = this.url;
        this.responseText = JSON.stringify(payload);
        queueMicrotask(() => this.listeners.load?.forEach((listener) => listener.call(this)));
      }
    }
    window.XMLHttpRequest = FixtureXHR;
    const calls = [];
    window.fetch = vi.fn(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return jsonResponse(payload);
    });
    window.eval(capabilitySource);

    const request = new window.XMLHttpRequest();
    request.open('GET', cartUrl);
    request.setRequestHeader('x-cart', 'observed');
    request.send();

    await vi.waitFor(async () => expect(await window.__gppuLoblawCapability.readCart(['milk_EA']))
      .toMatchObject({ inspectable: true, presentProductIds: ['milk_EA'] }));
    expect(calls.at(-1).options.credentials).toBe('include');
    expect(calls.at(-1).options.headers.get('x-cart')).toBe('observed');
    await expect(window.__gppuLoblawCapability.addProduct('milk_EA')).resolves.toEqual({ status: 'added' });
  });

  it('uses the authenticated customer-carts XHR to verify the current exact cart', async () => {
    window.history.replaceState({}, '', '/en/search?search-bar=milk&storeId=fixture-store&cartId=cart_fixture');
    const customerCartsUrl = 'https://api.pcexpress.ca/pcx-bff/api/v1/customers/customer_fixture/carts';
    const cartPayload = { entries: { milk_EA: {
      quantity: 1, fulfillmentMethod: 'pickup', sellerId: 'fixture-store'
    } } };
    class FixtureXHR {
      constructor() { this.listeners = {}; this.responseType = ''; this.withCredentials = true; }
      open(method, url) { this.method = method; this.url = String(url); }
      setRequestHeader(name, value) { this.headers ||= []; this.headers.push([name, value]); }
      addEventListener(type, listener) { this.listeners[type] ||= []; this.listeners[type].push(listener); }
      getResponseHeader(name) { return String(name).toLowerCase() === 'content-type' ? 'application/json' : null; }
      send() {
        this.status = 200;
        this.responseURL = this.url;
        this.responseText = JSON.stringify({ carts: [{ id: 'cart_fixture' }] });
        queueMicrotask(() => this.listeners.load?.forEach((listener) => listener.call(this)));
      }
    }
    window.XMLHttpRequest = FixtureXHR;
    const calls = [];
    window.fetch = vi.fn(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return jsonResponse(cartPayload);
    });
    window.eval(capabilitySource);

    const request = new window.XMLHttpRequest();
    request.open('GET', customerCartsUrl);
    request.setRequestHeader('authorization', 'private-value');
    request.send();

    await vi.waitFor(async () => expect(await window.__gppuLoblawCapability.readCart(['milk_EA']))
      .toMatchObject({ inspectable: true, presentProductIds: ['milk_EA'] }));
    expect(calls[0].url).toBe('https://api.pcexpress.ca/pcx-bff/api/v1/carts/cart_fixture');
    expect(calls[0].options.headers.get('authorization')).toBe('private-value');
  });

  it('fails closed when a cart POST cannot prove the requested product is present', async () => {
    window.history.replaceState({}, '', '/en/search?search-bar=milk&storeId=fixture-store&cartId=cart_fixture');
    document.cookie = 'fulfillment_pickup_type=pickup; path=/';
    const cartUrl = 'https://api.pcexpress.ca/pcx-bff/api/v2/carts/cart_fixture';
    window.fetch = vi.fn(async () => jsonResponse({ entries: {
      other_EA: { quantity: 1, fulfillmentMethod: 'pickup', sellerId: 'fixture-store' }
    } }));
    window.eval(capabilitySource);
    await window.fetch(cartUrl, { method: 'GET' });
    await vi.waitFor(() => expect(window.__gppuLoblawCapability.addProduct('milk_EA')).resolves.toBeNull());
  });

  it('rejects absent, unknown, and failed direct-query templates without mutating page state', async () => {
    let fail = false;
    window.fetch = vi.fn(async () => fail
      ? new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } })
      : jsonResponse(payloadFor('milk_EA')));
    window.eval(capabilitySource);
    expect(await window.__gppuLoblawCapability.queryProducts('rice')).toBeNull();

    const endpoint = 'https://api.pcexpress.ca/pcx-bff/api/v2/products/search';
    await window.fetch(endpoint, { method: 'POST', body: JSON.stringify({ unrelated: 'milk' }) });
    expect(await window.__gppuLoblawCapability.queryProducts('rice')).toBeNull();

    await window.fetch(endpoint, { method: 'POST', body: searchRequest(null).body });
    fail = true;
    expect(await window.__gppuLoblawCapability.queryProducts('rice')).toBeNull();
  });

  it('returns the retailer fetch promise unchanged', async () => {
    const nativePromise = Promise.resolve(new Response('{}', { status: 200 }));
    window.fetch = vi.fn(() => nativePromise);
    window.eval(source);

    const observed = window.fetch('https://api.pcexpress.ca/pcx-bff/api/v2/products/search', {
      method: 'POST', body: JSON.stringify({ listingInfo: { filters: { 'search-bar': ['milk'] } } })
    });

    expect(observed).toBe(nativePromise);
    await observed;
  });

  it('sanitizes embedded Next.js product tiles without making a request', () => {
    const payload = {
      props: { pageProps: { initialSearchData: {
        searchTermSubmitted: 'Milk',
        layout: { sections: { mainContentCollection: { components: [{ data: { productTiles: [{
          productId: '21554346_EA',
          title: '2% Milk',
          brand: 'Dairyland',
          packageSizing: '1.89 l, $0.40/100ml',
          pricing: { price: '7.58', wasPrice: '8.00', displayPrice: '$7.58' },
          pricingUnits: { weighted: false },
          link: '/en/2-milk/p/21554346_EA',
          description: 'This large field must not cross the bridge.'
        }] } }] } } }
      } } }
    };
    const nextData = document.createElement('script');
    nextData.id = '__NEXT_DATA__';
    nextData.type = 'application/json';
    nextData.textContent = JSON.stringify(payload);
    document.body.append(nextData);

    const nativeFetch = window.fetch;
    window.eval(source);
    const state = window[Symbol.for('rcss-price-per-unit.api-capture.v1')];
    expect(nativeFetch).not.toHaveBeenCalled();
    expect(state.context).toMatchObject({ query: 'milk', storeId: 'fixture-store' });
    expect(state.products['21554346_EA']).toEqual(expect.objectContaining({
      id: '21554346_EA',
      name: '2% Milk',
      packageSizing: '1.89 l, $0.40/100ml',
      currentPrice: 7.58,
      regularPrice: 8
    }));
    expect(state.products['21554346_EA']).not.toHaveProperty('description');
  });

  it('refines a same-document bootstrap when Superstore appends its store identity', async () => {
    window.history.replaceState({}, '', '/en/search?search-bar=milk');
    document.body.innerHTML = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { initialSearchData: payloadFor('milk_EA') } }
    })}</script>`;
    window.eval(source);
    const state = window[Symbol.for('rcss-price-per-unit.api-capture.v1')];
    expect(state.context).toMatchObject({ query: 'milk', storeId: null, requestSequence: 0 });
    expect(Object.keys(state.products)).toEqual(['milk_EA']);

    window.history.replaceState({}, '', '/en/search?search-bar=milk&storeId=3730');
    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: location.origin,
      data: { source: 'rcss-price-per-unit', version: 2, type: 'api-products-request' }
    }));

    await vi.waitFor(() => expect(state.context).toMatchObject({
      query: 'milk', storeId: '3730', requestSequence: 0
    }));
    expect(state.scope).toContain('query:milk|store:3730');
    expect(state.revision).toBe(2);
    expect(Object.keys(state.products)).toEqual(['milk_EA']);
  });

  it('never relabels bootstrap products after a search or path transition', () => {
    window.history.replaceState({}, '', '/en/search?search-bar=milk');
    document.body.innerHTML = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { initialSearchData: payloadFor('milk_EA') } }
    })}</script>`;
    window.eval(source);
    const state = window[Symbol.for('rcss-price-per-unit.api-capture.v1')];

    window.history.replaceState({}, '', '/en/search?search-bar=rice&storeId=3730');
    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: location.origin,
      data: { source: 'rcss-price-per-unit', version: 2, type: 'api-products-request' }
    }));

    expect(state.context).toMatchObject({ query: 'milk', storeId: null, requestSequence: 0 });
    expect(state.revision).toBe(1);
    expect(Object.keys(state.products)).toEqual(['milk_EA']);

    window.history.replaceState({}, '', '/en/food/dairy?search-bar=milk&storeId=3730');
    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: location.origin,
      data: { source: 'rcss-price-per-unit', version: 2, type: 'api-products-request' }
    }));
    expect(state.context).toMatchObject({ query: 'milk', storeId: null, requestSequence: 0 });
    expect(state.revision).toBe(1);
  });

  it('ignores malformed products and caps the bridge to sanitized fields', () => {
    document.body.innerHTML = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { initialSearchData: {
        searchTerm: 'milk',
        layout: { sections: { mainContentCollection: { components: [{ data: { productTiles: [
          { productId: '../bad', title: 'Bad', pricing: { price: '1.00' } },
          { productId: 'good_EA', title: 'Good', pricing: { price: 'not money' } }
        ] } }] } } }
      } } }
    })}</script>`;
    window.eval(source);
    const products = window[Symbol.for('rcss-price-per-unit.api-capture.v1')].products;
    expect(Object.keys(products)).toEqual(['good_EA']);
    expect(products.good_EA.currentPrice).toBeNull();
  });

  it('bounds inspected product tiles cumulatively before reading a huge sparse response', async () => {
    let numericReads = 0;
    const sparseTiles = new Proxy([], {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) numericReads += 1;
        if (property === 'length') return 1_000_000_000;
        return Reflect.get(target, property, receiver);
      }
    });
    const payload = {
      searchTermSubmitted: 'milk',
      layout: { sections: { mainContentCollection: { components: [{ data: { productTiles: sparseTiles } }] } } }
    };
    const endpoint = 'https://api.pcexpress.ca/pcx-bff/api/v2/products/search';
    window.fetch = vi.fn(async () => ({
      ok: true,
      url: endpoint,
      headers: { get: () => 'application/json' },
      clone: () => ({ json: async () => payload })
    }));
    window.eval(source);

    await window.fetch(endpoint, searchRequest(null));
    await vi.waitFor(() => expect(window[Symbol.for('rcss-price-per-unit.api-capture.v1')].revision).toBe(1));
    expect(numericReads).toBe(2_000);
    expect(window[Symbol.for('rcss-price-per-unit.api-capture.v1')].products).toEqual({});
  });

  it('shares the inspection budget across duplicated roots while preserving 500 early valid products', async () => {
    const valid = Array.from({ length: 500 }, (_, index) => ({
      productId: `valid-${index}_EA`,
      title: `Valid ${index}`,
      pricing: { price: '1.00' }
    }));
    const firstCandidates = [...Array.from({ length: 1_500 }), ...valid];
    const secondCandidates = Array.from({ length: 1_000 });
    const firstRoot = { layout: { sections: { mainContentCollection: { components: [{ data: { productTiles: firstCandidates } }] } } } };
    const secondRoot = { layout: { sections: { mainContentCollection: { components: [{ data: { productTiles: secondCandidates } }] } } } };
    const payload = { searchTermSubmitted: 'milk', ...firstRoot, data: secondRoot };
    const endpoint = 'https://api.pcexpress.ca/pcx-bff/api/v2/products/search';
    window.fetch = vi.fn(async () => ({
      ok: true,
      url: endpoint,
      headers: { get: () => 'application/json' },
      clone: () => ({ json: async () => payload })
    }));
    window.eval(source);

    await window.fetch(endpoint, searchRequest(null));
    await vi.waitFor(() => expect(Object.keys(window[Symbol.for('rcss-price-per-unit.api-capture.v1')].products)).toHaveLength(500));
    expect(window[Symbol.for('rcss-price-per-unit.api-capture.v1')].products['valid-499_EA']).toBeDefined();
  });

  it('treats zero and oversized retailer prices as unavailable sentinels', () => {
    document.body.innerHTML = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { initialSearchData: {
        searchTerm: 'milk',
        layout: { sections: { mainContentCollection: { components: [{ data: { productTiles: [
          { productId: 'zero_EA', title: 'Zero sentinel', pricing: { price: '0', wasPrice: 0 } },
          { productId: 'large_EA', title: 'Oversized sentinel', pricing: { price: '1000001' } }
        ] } }] } } }
      } } }
    })}</script>`;
    window.eval(source);
    const products = window[Symbol.for('rcss-price-per-unit.api-capture.v1')].products;
    expect(products.zero_EA).toMatchObject({ currentPrice: null, regularPrice: null });
    expect(products.large_EA.currentPrice).toBeNull();
  });

  it('replaces the first search with a later Next.js search response', async () => {
    const first = { props: { pageProps: { initialSearchData: {
      searchTermSubmitted: 'milk',
      layout: { sections: { mainContentCollection: { components: [{ data: { productTiles: [
        { productId: 'milk_EA', title: 'Milk', packageSizing: '4 l, $0.16/100ml', pricing: { price: '6.40' } }
      ] } }] } } }
    } } } };
    document.body.innerHTML = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(first)}</script>`;
    const next = { pageProps: { initialSearchData: {
      searchTermSubmitted: 'rice',
      layout: { sections: { mainContentCollection: { components: [{ data: { productTiles: [
        { productId: 'rice_EA', title: 'Rice', packageSizing: '2 kg', pricing: { price: '4.00' } }
      ] } }] } } }
    } } };
    window.fetch = vi.fn(async () => new Response(JSON.stringify(next), {
      status: 200, headers: { 'content-type': 'application/json' }
    }));
    window.eval(source);

    await window.fetch('https://www.realcanadiansuperstore.ca/_next/data/build/en/search.json?search-bar=rice');
    await vi.waitFor(() => {
      const state = window[Symbol.for('rcss-price-per-unit.api-capture.v1')];
      expect(state.context.query).toBe('rice');
      expect(Object.keys(state.products)).toEqual(['rice_EA']);
    });
  });

  it('accumulates later API pages for the same search', async () => {
    const first = { props: { pageProps: { initialSearchData: {
      searchTermSubmitted: 'milk',
      layout: { sections: { mainContentCollection: { components: [{ data: { productTiles: [
        { productId: 'milk_EA', title: 'Milk', packageSizing: '4 l', pricing: { price: '6.40' } }
      ] } }] } } }
    } } } };
    document.body.innerHTML = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(first)}</script>`;
    const laterPage = { searchTermSubmitted: 'milk', layout: { sections: { mainContentCollection: { components: [{ data: { productTiles: [
      { productId: 'cream_EA', title: 'Cream', packageSizing: '1 l', pricing: { price: '4.00' } }
    ] } }] } } } };
    window.fetch = vi.fn(async () => new Response(JSON.stringify(laterPage), {
      status: 200, headers: { 'content-type': 'application/json' }
    }));
    window.eval(source);

    await window.fetch('https://api.pcexpress.ca/pcx-bff/api/v2/products/search', {
      method: 'POST',
      body: JSON.stringify({ listingInfo: { filters: { 'search-bar': ['milk'] }, pagination: { from: 48 } } })
    });
    await vi.waitFor(() => {
      const state = window[Symbol.for('rcss-price-per-unit.api-capture.v1')];
      expect(state.context).toMatchObject({ query: 'milk', page: 48 });
      expect(Object.keys(state.products)).toEqual(['milk_EA', 'cream_EA']);
    });
  });

  it('observes a No Frills Next.js search response', async () => {
    const response = { pageProps: { initialSearchData: {
      searchTermSubmitted: 'rice',
      layout: { sections: { mainContentCollection: { components: [{ data: { productTiles: [
        { productId: 'nf-rice_EA', title: 'No Name Rice', packageSizing: '2 kg', pricing: { price: '4.00' } }
      ] } }] } } }
    } } };
    window.fetch = vi.fn(async () => new Response(JSON.stringify(response), {
      status: 200, headers: { 'content-type': 'application/json' }
    }));
    window.eval(source);

    await window.fetch('https://www.nofrills.ca/_next/data/build/en/search.json?search-bar=rice');
    await vi.waitFor(() => {
      const state = window[Symbol.for('rcss-price-per-unit.api-capture.v1')];
      expect(state.context.query).toBe('rice');
      expect(state.products['nf-rice_EA']).toMatchObject({ name: 'No Name Rice', packageSizing: '2 kg' });
    });
  });

  it('rejects delayed old filters while preserving a newer filter and its pagination', async () => {
    const resolvers = new Map();
    window.fetch = vi.fn((url, options) => new Promise((resolve) => {
      const body = JSON.parse(options.body);
      const brand = body.listingInfo.filters.brand[0];
      const from = body.listingInfo.pagination?.from || 0;
      resolvers.set(`${brand}:${from}`, resolve);
    }));
    window.eval(source);
    const endpoint = 'https://api.pcexpress.ca/pcx-bff/api/v2/products/search';

    const oldRequest = window.fetch(endpoint, searchRequest('old'));
    const currentRequest = window.fetch(endpoint, searchRequest('current'));
    const currentPage = window.fetch(endpoint, searchRequest('current', 48));
    resolvers.get('current:0')(jsonResponse(payloadFor('current_EA')));
    await currentRequest;
    resolvers.get('current:48')(jsonResponse(payloadFor('current-page_EA')));
    await currentPage;
    resolvers.get('old:0')(jsonResponse(payloadFor('old_EA')));
    await oldRequest;

    await vi.waitFor(() => {
      const state = window[Symbol.for('rcss-price-per-unit.api-capture.v1')];
      expect(Object.keys(state.products)).toEqual(['current_EA', 'current-page_EA']);
      expect(state.context.page).toBe(48);
    });
  });

  it('keeps later-page products when the matching first page resolves afterwards', async () => {
    const resolvers = [];
    window.fetch = vi.fn(() => new Promise((resolve) => resolvers.push(resolve)));
    window.eval(source);
    const endpoint = 'https://api.pcexpress.ca/pcx-bff/api/v2/products/search';

    const firstPage = window.fetch(endpoint, searchRequest('current'));
    const laterPage = window.fetch(endpoint, searchRequest('current', 48));
    resolvers[1](jsonResponse(payloadFor('later_EA')));
    await laterPage;
    resolvers[0](jsonResponse(payloadFor('first_EA')));
    await firstPage;

    await vi.waitFor(() => {
      const state = window[Symbol.for('rcss-price-per-unit.api-capture.v1')];
      expect(Object.keys(state.products)).toEqual(['later_EA', 'first_EA']);
    });
  });

  it('rejects pagination requested before a refreshed base page of the same filter', async () => {
    const resolvers = [];
    window.fetch = vi.fn(() => new Promise((resolve) => resolvers.push(resolve)));
    window.eval(source);
    const endpoint = 'https://api.pcexpress.ca/pcx-bff/api/v2/products/search';

    const oldBase = window.fetch(endpoint, searchRequest('current'));
    const oldPage = window.fetch(endpoint, searchRequest('current', 48));
    const refreshedBase = window.fetch(endpoint, searchRequest('current'));
    resolvers[2](jsonResponse(payloadFor('refreshed_EA')));
    await refreshedBase;
    resolvers[1](jsonResponse(payloadFor('stale-page_EA')));
    await oldPage;
    resolvers[0](jsonResponse(payloadFor('stale-base_EA')));
    await oldBase;

    await vi.waitFor(() => expect(Object.keys(window[Symbol.for('rcss-price-per-unit.api-capture.v1')].products))
      .toEqual(['refreshed_EA']));
  });

  it('clears an authoritative empty first page and recovers on the next valid snapshot', async () => {
    document.body.innerHTML = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payloadFor('initial_EA'))}</script>`;
    const responses = [jsonResponse({}), jsonResponse(payloadFor('recovered_EA'))];
    window.fetch = vi.fn(async () => responses.shift());
    window.eval(source);
    const endpoint = 'https://api.pcexpress.ca/pcx-bff/api/v2/products/search';

    await window.fetch(endpoint, searchRequest(null));
    await vi.waitFor(() => expect(window[Symbol.for('rcss-price-per-unit.api-capture.v1')].products).toEqual({}));
    await window.fetch(endpoint, searchRequest(null));
    await vi.waitFor(() => expect(Object.keys(window[Symbol.for('rcss-price-per-unit.api-capture.v1')].products))
      .toEqual(['recovered_EA']));
  });

  it('preserves the snapshot for empty pagination and failed or non-JSON responses', async () => {
    document.body.innerHTML = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payloadFor('initial_EA'))}</script>`;
    const redirected = jsonResponse({});
    Object.defineProperty(redirected, 'url', { value: 'https://example.test/not-search' });
    const responses = [
      jsonResponse({}),
      new Response('not json', { status: 200, headers: { 'content-type': 'text/html' } }),
      new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }),
      redirected
    ];
    window.fetch = vi.fn(async () => responses.shift());
    window.eval(source);
    const endpoint = 'https://api.pcexpress.ca/pcx-bff/api/v2/products/search';

    await window.fetch(endpoint, searchRequest(null, 48));
    await window.fetch(endpoint, searchRequest(null));
    await window.fetch(endpoint, searchRequest(null));
    await window.fetch(endpoint, searchRequest(null));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(Object.keys(window[Symbol.for('rcss-price-per-unit.api-capture.v1')].products)).toEqual(['initial_EA']);
  });
});
