// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';

const source = fs.readFileSync('src/retailers/saveon/api-capture-main.js', 'utf8');

beforeEach(() => {
  window.history.replaceState({}, '', '/sm/pickup/rsid/6632/results?q=eggs');
  delete window[Symbol.for('saveon-price-per-unit.api-capture.v1')];
  delete window.__PRELOADED_STATE__;
  window.fetch = vi.fn(async () => new Response('{}', { status: 200 }));
});

afterEach(() => {
  // Exercise the observer's page-lifetime cleanup before jsdom tears down the
  // window or the next case deliberately removes the duplicate-install claim.
  window.dispatchEvent(new Event('pagehide'));
});

it('stops the bootstrap retry when the page is handed off', async () => {
  const clearInterval = vi.spyOn(window, 'clearInterval');
  window.eval(source);
  window.dispatchEvent(new Event('pagehide'));

  expect(clearInterval).toHaveBeenCalledTimes(1);
  await new Promise((resolve) => setTimeout(resolve, 70));
  expect(clearInterval).toHaveBeenCalledTimes(1);
});

it('preserves Save-On prices and normalizes its per-item API notation', async () => {
  window.__PRELOADED_STATE__ = { search: {
    products: { searchResults: ['00062639410124'] },
    productCardDictionary: {
      '00062639410124': {
        sku: '00062639410124',
        name: 'Western Family - Large White Eggs',
        priceNumeric: '$4.29',
        unitPrice: '$0.36 each',
        unitOfSize: { size: '12', type: 'each' },
        sellBy: 'each'
      }
    }
  } };

  window.eval(source);
  await vi.waitFor(() => {
    const product = window[Symbol.for('saveon-price-per-unit.api-capture.v1')].products['00062639410124'];
    expect(product).toMatchObject({
      currentPrice: 4.29,
      unitPrice: '$0.36/each',
      unitOfSize: { size: 12, type: 'each' }
    });
  });
});

it('treats zero and oversized retailer prices as unavailable sentinels', async () => {
  window.__PRELOADED_STATE__ = { search: {
    products: { searchResults: ['zero', 'negative-zero', 'oversized'] },
    productCardDictionary: {
      zero: { sku: 'zero', name: 'Zero sentinel', priceNumeric: 0 },
      'negative-zero': { sku: 'negative-zero', name: 'Negative zero sentinel', priceNumeric: -0 },
      oversized: { sku: 'oversized', name: 'Oversized sentinel', priceNumeric: 1_000_001 }
    }
  } };

  window.eval(source);
  await vi.waitFor(() => {
    const products = window[Symbol.for('saveon-price-per-unit.api-capture.v1')].products;
    expect(products.zero.currentPrice).toBeNull();
    expect(products['negative-zero'].currentPrice).toBeNull();
    expect(products.oversized.currentPrice).toBeNull();
  });
});

it('captures Save-On page-2 products loaded through XMLHttpRequest', async () => {
  window.history.replaceState({}, '', '/sm/pickup/rsid/6632/results?q=apples');
  class FakeXMLHttpRequest {
    listeners = {};
    open() {}
    addEventListener(type, callback) { this.listeners[type] = callback; }
    send() {
      this.responseText = JSON.stringify({ items: [{
        sku: 'page-two',
        name: 'Page Two Apple Juice',
        priceNumeric: 3.49,
        pricePerUnit: '$0.35/100ml',
        unitOfSize: { size: 1, type: 'litre' }
      }] });
      this.listeners.load?.();
    }
  }
  window.XMLHttpRequest = FakeXMLHttpRequest;
  window.eval(source);

  const request = new window.XMLHttpRequest();
  request.open('GET', 'https://storefrontgateway.saveonfoods.com/api/stores/6632/search?q=apples&take=30&skip=30&page=2');
  request.send();

  await vi.waitFor(() => {
    expect(window[Symbol.for('saveon-price-per-unit.api-capture.v1')].products['page-two']).toMatchObject({
      currentPrice: 3.49,
      unitPrice: '$0.35/100ml'
    });
  });
});

it('bounds sparse response arrays before examining or retaining products', async () => {
  let reads = 0;
  const items = new Proxy([], {
    get(target, property, receiver) {
      if (property === 'length') return 1_000_000_000;
      if (/^\d+$/.test(String(property))) {
        reads += 1;
        if (reads > 500) throw new Error('response breadth was not bounded');
        return {
          sku: `bounded-${property}`,
          name: `Bounded product ${property}`,
          priceNumeric: 4,
          unitPrice: '$0.40/each'
        };
      }
      return Reflect.get(target, property, receiver);
    }
  });
  window.fetch = vi.fn(async () => ({
    ok: true,
    headers: { get: () => 'application/json' },
    clone: () => ({ json: async () => ({ items }) })
  }));
  window.eval(source);

  await window.fetch('https://storefrontgateway.saveonfoods.com/api/stores/6632/search?q=eggs');
  await vi.waitFor(() => expect(Object.keys(
    window[Symbol.for('saveon-price-per-unit.api-capture.v1')].products
  )).toHaveLength(500));
  expect(reads).toBe(500);
});

it('bounds wide object traversal without reading every property', async () => {
  let reads = 0;
  const wide = {};
  for (let index = 0; index < 1000; index += 1) {
    Object.defineProperty(wide, `product${index}`, {
      enumerable: true,
      get() {
        reads += 1;
        return {
          sku: `wide-${index}`,
          name: `Wide product ${index}`,
          priceNumeric: 4,
          unitOfSize: { size: 1, type: 'each' }
        };
      }
    });
  }
  window.fetch = vi.fn(async () => ({
    ok: true,
    headers: { get: () => 'application/json' },
    clone: () => ({ json: async () => ({ wide }) })
  }));
  window.eval(source);

  await window.fetch('https://storefrontgateway.saveonfoods.com/api/stores/6632/search?q=eggs');
  await vi.waitFor(() => expect(Object.keys(
    window[Symbol.for('saveon-price-per-unit.api-capture.v1')].products
  )).toHaveLength(500));
  expect(reads).toBe(500);
});

it('does not inspect unrelated Save-On API responses', async () => {
  const clone = vi.fn(() => ({ json: vi.fn(async () => ({ items: [] })) }));
  window.fetch = vi.fn(async () => ({ clone }));
  window.eval(source);

  await window.fetch('https://storefrontgateway.saveonfoods.com/api/cart?q=eggs');
  await Promise.resolve();

  expect(clone).not.toHaveBeenCalled();
});

it('ignores a late response after the search scope changes', async () => {
  let resolveFirst;
  const firstResponse = new Promise((resolve) => { resolveFirst = resolve; });
  window.fetch = vi.fn(() => firstResponse);
  window.eval(source);

  const pending = window.fetch('https://storefrontgateway.saveonfoods.com/api/stores/6632/search?q=eggs');
  window.history.replaceState({}, '', '/sm/pickup/rsid/6632/results?q=milk');
  resolveFirst(new Response(JSON.stringify({ items: [{
    sku: 'late-eggs',
    name: 'Late Eggs',
    priceNumeric: 4.29,
    unitPrice: '$0.36/each'
  }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  await pending;
  await Promise.resolve();
  await Promise.resolve();

  expect(window[Symbol.for('saveon-price-per-unit.api-capture.v1')].products['late-eggs']).toBeUndefined();
});

it('does not relabel document bootstrap products after SPA navigation', async () => {
  window.__PRELOADED_STATE__ = { search: {
    products: { searchResults: ['bootstrap-eggs'] },
    productCardDictionary: {
      'bootstrap-eggs': { sku: 'bootstrap-eggs', name: 'Bootstrap Eggs', priceNumeric: 4, unitPrice: '$0.33/each' }
    }
  } };
  window.eval(source);
  await vi.waitFor(() => expect(window[Symbol.for('saveon-price-per-unit.api-capture.v1')].products['bootstrap-eggs']).toBeTruthy());

  window.history.replaceState({}, '', '/sm/pickup/rsid/6632/results?q=milk');
  window.dispatchEvent(new MessageEvent('message', {
    source: window,
    origin: window.location.origin,
    data: { source: 'saveon-price-per-unit', version: 2, type: 'api-products-request' }
  }));

  await vi.waitFor(() => {
    const state = window[Symbol.for('saveon-price-per-unit.api-capture.v1')];
    expect(state.pageScope).toContain('q=milk');
    expect(state.products['bootstrap-eggs']).toBeUndefined();
  });
});

it('never adopts document bootstrap data when installed outside a results route', async () => {
  window.history.replaceState({}, '', '/sm/pickup/rsid/6632/home');
  window.__PRELOADED_STATE__ = { search: {
    products: { searchResults: ['stale-home'] },
    productCardDictionary: {
      'stale-home': { sku: 'stale-home', name: 'Stale Home Product', priceNumeric: 4, unitPrice: '$0.33/each' }
    }
  } };
  window.eval(source);
  window.history.replaceState({}, '', '/sm/pickup/rsid/6632/results?q=milk');
  window.dispatchEvent(new MessageEvent('message', {
    source: window,
    origin: window.location.origin,
    data: { source: 'saveon-price-per-unit', version: 2, type: 'api-products-request' }
  }));

  await vi.waitFor(() => {
    const state = window[Symbol.for('saveon-price-per-unit.api-capture.v1')];
    expect(state.pageScope).toContain('q=milk');
    expect(state.products['stale-home']).toBeUndefined();
  });
});

it('rejects a redirected or unrelated final response before cloning', async () => {
  const clone = vi.fn();
  window.fetch = vi.fn(async () => ({
    ok: true,
    url: 'https://storefrontgateway.saveonfoods.com/api/account?q=eggs',
    headers: { get: () => 'application/json' },
    clone
  }));
  window.eval(source);

  await window.fetch('https://storefrontgateway.saveonfoods.com/api/stores/6632/search?q=eggs');
  await Promise.resolve();

  expect(clone).not.toHaveBeenCalled();
});

it('rejects a fetch whose API store does not match the pickup route', async () => {
  window.history.replaceState({}, '', '/sm/pickup/rsid/9999/results?q=eggs');
  const clone = vi.fn();
  window.fetch = vi.fn(async () => ({ ok: true, clone }));
  window.eval(source);

  await window.fetch('https://storefrontgateway.saveonfoods.com/api/stores/6632/search?q=eggs');
  await Promise.resolve();

  expect(clone).not.toHaveBeenCalled();
  expect(window[Symbol.for('saveon-price-per-unit.api-capture.v1')].products).toEqual({});
});

it('does not attach an XHR capture to another pickup store', () => {
  window.history.replaceState({}, '', '/sm/pickup/rsid/9999/results?q=eggs');
  class FakeXMLHttpRequest {
    listeners = {};
    open() {}
    addEventListener(type, callback) { this.listeners[type] = callback; }
    send() {}
  }
  window.XMLHttpRequest = FakeXMLHttpRequest;
  window.eval(source);

  const request = new window.XMLHttpRequest();
  request.open('GET', 'https://storefrontgateway.saveonfoods.com/api/stores/6632/search?q=eggs');
  request.send();

  expect(request.listeners.load).toBeUndefined();
});

it('rejects a same-query final response whose store or filter changed', async () => {
  const clone = vi.fn();
  const responses = [
    {
      ok: true,
      url: 'https://storefrontgateway.saveonfoods.com/api/stores/6632/search?q=eggs&category=organic',
      headers: { get: () => 'application/json' },
      clone
    },
    {
      ok: true,
      url: 'https://storefrontgateway.saveonfoods.com/api/stores/9999/search?q=eggs&category=regular',
      headers: { get: () => 'application/json' },
      clone
    }
  ];
  window.fetch = vi.fn(async () => responses.shift());
  window.eval(source);

  await window.fetch('https://storefrontgateway.saveonfoods.com/api/stores/6632/search?q=eggs&category=regular');
  await window.fetch('https://storefrontgateway.saveonfoods.com/api/stores/6632/search?q=eggs&category=regular');
  await Promise.resolve();

  expect(clone).not.toHaveBeenCalled();
});

it('rejects an older same-query filter response while merging pagination', async () => {
  const resolvers = new Map();
  window.fetch = vi.fn((url) => new Promise((resolve) => resolvers.set(String(url), resolve)));
  window.eval(source);
  const endpoint = 'https://storefrontgateway.saveonfoods.com/api/stores/6632/search?q=eggs';
  const older = window.fetch(`${endpoint}&category=organic&take=30&skip=0`);
  const newer = window.fetch(`${endpoint}&category=regular&take=30&skip=0`);
  resolvers.get(`${endpoint}&category=regular&take=30&skip=0`)(new Response(JSON.stringify({ items: [{
    sku: 'regular-eggs', name: 'Regular Eggs', priceNumeric: 4, unitPrice: '$0.33/each'
  }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  await newer;
  await vi.waitFor(() => expect(window[Symbol.for('saveon-price-per-unit.api-capture.v1')].products['regular-eggs']).toBeTruthy());
  resolvers.get(`${endpoint}&category=organic&take=30&skip=0`)(new Response(JSON.stringify({ items: [{
    sku: 'organic-eggs', name: 'Organic Eggs', priceNumeric: 7, unitPrice: '$0.58/each'
  }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  await older;
  await Promise.resolve();

  const products = window[Symbol.for('saveon-price-per-unit.api-capture.v1')].products;
  expect(products['regular-eggs']).toBeTruthy();
  expect(products['organic-eggs']).toBeUndefined();
});

it('keeps bootstrap products when the unfiltered second API page arrives', async () => {
  window.__PRELOADED_STATE__ = { search: {
    products: { searchResults: ['page-one'] },
    productCardDictionary: {
      'page-one': { sku: 'page-one', name: 'Page One Eggs', priceNumeric: 4, unitPrice: '$0.33/each' }
    }
  } };
  window.fetch = vi.fn(async () => new Response(JSON.stringify({ items: [{
    sku: 'page-two', name: 'Page Two Eggs', priceNumeric: 5, unitPrice: '$0.42/each'
  }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  window.eval(source);
  await vi.waitFor(() => expect(window[Symbol.for('saveon-price-per-unit.api-capture.v1')].products['page-one']).toBeTruthy());

  await window.fetch('https://storefrontgateway.saveonfoods.com/api/stores/6632/search?q=eggs&take=30&skip=30&page=2');

  await vi.waitFor(() => {
    const products = window[Symbol.for('saveon-price-per-unit.api-capture.v1')].products;
    expect(Object.keys(products).sort()).toEqual(['page-one', 'page-two']);
  });
});

it('clears an authoritative empty first page but preserves an empty later page', async () => {
  window.__PRELOADED_STATE__ = { search: {
    products: { searchResults: ['initial-eggs'] },
    productCardDictionary: {
      'initial-eggs': { sku: 'initial-eggs', name: 'Initial Eggs', priceNumeric: 4, unitPrice: '$0.33/each' }
    }
  } };
  const responses = [
    new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  ];
  window.fetch = vi.fn(async () => responses.shift());
  window.eval(source);
  const endpoint = 'https://storefrontgateway.saveonfoods.com/api/stores/6632/search?q=eggs';
  await vi.waitFor(() => expect(window[Symbol.for('saveon-price-per-unit.api-capture.v1')].products['initial-eggs']).toBeTruthy());

  await window.fetch(`${endpoint}&take=30&skip=30&page=2`);
  await Promise.resolve();
  expect(Object.keys(window[Symbol.for('saveon-price-per-unit.api-capture.v1')].products)).toEqual(['initial-eggs']);

  await window.fetch(`${endpoint}&take=30&skip=0&page=0`);
  await vi.waitFor(() => expect(window[Symbol.for('saveon-price-per-unit.api-capture.v1')].products).toEqual({}));
});

it('rejects an older duplicate first-page response for the same filter', async () => {
  const resolvers = [];
  window.fetch = vi.fn(() => new Promise((resolve) => resolvers.push(resolve)));
  window.eval(source);
  const endpoint = 'https://storefrontgateway.saveonfoods.com/api/stores/6632/search?q=eggs&category=regular';
  const older = window.fetch(endpoint);
  const newer = window.fetch(endpoint);
  resolvers[1](new Response(JSON.stringify({ items: [{
    sku: 'new-eggs', name: 'New Eggs', priceNumeric: 5, unitPrice: '$0.42/each'
  }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  await newer;
  resolvers[0](new Response(JSON.stringify({ items: [{
    sku: 'old-eggs', name: 'Old Eggs', priceNumeric: 4, unitPrice: '$0.33/each'
  }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  await older;

  await vi.waitFor(() => {
    const products = window[Symbol.for('saveon-price-per-unit.api-capture.v1')].products;
    expect(Object.keys(products)).toEqual(['new-eggs']);
  });
});

it('keeps a later page that resolves before its matching first page', async () => {
  const resolvers = [];
  window.fetch = vi.fn(() => new Promise((resolve) => resolvers.push(resolve)));
  window.eval(source);
  const endpoint = 'https://storefrontgateway.saveonfoods.com/api/stores/6632/search?q=eggs&category=regular';
  const first = window.fetch(endpoint);
  const later = window.fetch(`${endpoint}&skip=30&page=2`);
  resolvers[1](new Response(JSON.stringify({ items: [{
    sku: 'later-eggs', name: 'Later Eggs', priceNumeric: 6, unitPrice: '$0.50/each'
  }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  await later;
  resolvers[0](new Response(JSON.stringify({ items: [{
    sku: 'first-eggs', name: 'First Eggs', priceNumeric: 4, unitPrice: '$0.33/each'
  }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  await first;

  await vi.waitFor(() => {
    const products = window[Symbol.for('saveon-price-per-unit.api-capture.v1')].products;
    expect(Object.keys(products)).toEqual(['later-eggs', 'first-eggs']);
  });
});

it('rejects pagination requested before a refreshed same-filter base page', async () => {
  const resolvers = [];
  window.fetch = vi.fn(() => new Promise((resolve) => resolvers.push(resolve)));
  window.eval(source);
  const endpoint = 'https://storefrontgateway.saveonfoods.com/api/stores/6632/search?q=eggs&category=regular';
  const oldBase = window.fetch(endpoint);
  const oldPage = window.fetch(`${endpoint}&skip=30&page=2`);
  const refreshedBase = window.fetch(endpoint);
  resolvers[2](new Response(JSON.stringify({ items: [{
    sku: 'refreshed-eggs', name: 'Refreshed Eggs', priceNumeric: 5, unitPrice: '$0.42/each'
  }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  await refreshedBase;
  resolvers[1](new Response(JSON.stringify({ items: [{
    sku: 'stale-page-eggs', name: 'Stale Page Eggs', priceNumeric: 6, unitPrice: '$0.50/each'
  }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  await oldPage;
  resolvers[0](new Response(JSON.stringify({ items: [{
    sku: 'stale-base-eggs', name: 'Stale Base Eggs', priceNumeric: 4, unitPrice: '$0.33/each'
  }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  await oldBase;

  await vi.waitFor(() => expect(Object.keys(window[Symbol.for('saveon-price-per-unit.api-capture.v1')].products))
    .toEqual(['refreshed-eggs']));
});
