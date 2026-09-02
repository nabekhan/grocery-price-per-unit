// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

const source = `${fs.readFileSync('src/retailers/loblaw/api-capture-main.js', 'utf8')
  .replace('export function installLoblawCapture', 'function installLoblawCapture')}\ninstallLoblawCapture(window);`;

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
  delete window[Symbol.for('rcss-price-per-unit.api-capture.v1')];
  window.fetch = vi.fn(async () => new Response('{}', { status: 200 }));
});

describe('RCSS main-world search capture', () => {
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
