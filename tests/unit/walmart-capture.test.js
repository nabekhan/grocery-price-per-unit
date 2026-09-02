import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

const source = `${fs.readFileSync('src/retailers/walmart/api-capture-main.js', 'utf8')
  .replace('export function installWalmartCapture', 'function installWalmartCapture')}\ninstallWalmartCapture(window);`;

function installCapture(response, pageUrl = 'https://www.walmart.ca/search?q=milk&store=beta') {
  const nativeFetch = vi.fn(async (...args) => typeof response === 'function' ? response(...args) : response);
  const target = {
    location: { href: pageUrl, origin: 'https://www.walmart.ca' },
    Headers,
    document: {
      cookie: 'assortmentStoreId=beta',
      readyState: 'complete',
      getElementById() { return null; },
      addEventListener() {}
    },
    fetch: nativeFetch,
    addEventListener() {},
    postMessage: vi.fn(),
    console: { debug() {}, info() {}, warn() {}, error() {} }
  };
  vm.runInNewContext(source, {
    window: target,
    URL,
    Symbol,
    Promise,
    Reflect,
    Object,
    Array,
    Map,
    Set,
    WeakSet,
    Number,
    String,
    JSON,
    RegExp,
    Headers,
    encodeURIComponent,
    decodeURIComponent
  });
  return { target, nativeFetch };
}

function jsonResponse(payload, url = '') {
  return {
    ok: true,
    status: 200,
    url,
    headers: { get: () => 'application/json' },
    clone: () => ({ json: async () => payload }),
    json: async () => payload
  };
}

function searchUrl(variables) {
  return `https://www.walmart.ca/orchestra/snb/graphql/search?variables=${encodeURIComponent(JSON.stringify(variables))}`;
}

it('does not inspect a Walmart request whose store variable conflicts with the page', async () => {
  const clone = vi.fn();
  const { target, nativeFetch } = installCapture({ ok: true, status: 200, clone });

  await target.fetch(searchUrl({ query: 'milk', page: 1, store: 'alpha' }));
  await Promise.resolve();

  expect(nativeFetch).toHaveBeenCalledOnce();
  expect(clone).not.toHaveBeenCalled();
});

it('rejects a Walmart final response whose filter identity changed', async () => {
  const finalUrl = searchUrl({ query: 'milk', page: 1, store: 'beta', category: 'organic' });
  const clone = vi.fn(() => ({ json: vi.fn(async () => ({})) }));
  const { target } = installCapture({
    ok: true,
    status: 200,
    url: finalUrl,
    headers: { get: () => 'application/json' },
    clone
  });

  await target.fetch(searchUrl({ query: 'milk', page: 1, store: 'beta', category: 'regular' }));
  await Promise.resolve();
  await Promise.resolve();

  expect(clone).not.toHaveBeenCalled();
});

it('bounds sparse item-stack breadth before capture', async () => {
  let reads = 0;
  const items = new Proxy([], {
    get(target, property, receiver) {
      if (property === 'length') return 1_000_000_000;
      if (/^\d+$/.test(String(property))) {
        reads += 1;
        if (reads > 500) throw new Error('item-stack breadth was not bounded');
        return {
          id: `bounded-${property}`,
          name: `Bounded product ${property}`,
          priceInfo: { currentPrice: { price: 4 }, unitPrice: { priceString: '$0.40/each' } }
        };
      }
      return Reflect.get(target, property, receiver);
    }
  });
  const response = {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    clone: () => ({ json: async () => ({ data: { search: { itemStacks: [{ itemsV2: items }] } } }) })
  };
  const { target } = installCapture(response);

  await target.fetch(searchUrl({ query: 'milk', page: 1, store: 'beta' }));
  await vi.waitFor(() => {
    const messages = target.postMessage.mock.calls.map(([message]) => message)
      .filter((message) => message.type === 'api-products');
    expect(messages.at(-1).products).toHaveLength(500);
  });
  expect(reads).toBe(500);
});

it('rejects oversized initial Next data before parsing it', () => {
  let coerced = 0;
  const response = { ok: true, status: 200, clone: () => ({ json: async () => ({}) }) };
  const { target } = installCapture(response);
  target.document.getElementById = () => ({
    textContent: {
      length: 10_000_001,
      toString() {
        coerced += 1;
        throw new Error('oversized preloaded data was parsed');
      }
    }
  });

  expect(target[Symbol.for('walmart-price-per-unit.api-capture.v1')].captureNextDataOnce()).toBeUndefined();
  expect(coerced).toBe(0);
});

it('rejects stale initial Next data whose query conflicts with the current page', async () => {
  const response = { ok: true, status: 200, clone: () => ({ json: async () => ({}) }) };
  const { target } = installCapture(response);
  target.document.getElementById = () => ({
    textContent: JSON.stringify({
      props: { pageProps: { initialSearchQueryVariables: { query: 'eggs', page: 1, store: 'beta' } } },
      data: { search: { itemStacks: [{ itemsV2: [{
        id: 'stale-eggs', name: 'Stale Eggs 12 ct', priceInfo: { currentPrice: { price: 4 } }
      }] }] } }
    })
  });

  target[Symbol.for('walmart-price-per-unit.api-capture.v1')].captureNextDataOnce();
  await Promise.resolve();

  expect(target.postMessage.mock.calls.map(([message]) => message)
    .filter((message) => message.type === 'api-products')).toEqual([]);
});

it('replays an observed Search template with every query field updated', async () => {
  const requests = [];
  const { target } = installCapture((url, init) => {
    requests.push({ url: String(url), init });
    const variables = JSON.parse(new URL(String(url)).searchParams.get('variables'));
    return jsonResponse({
      data: { search: { itemStacks: [{ itemsV2: [{
        id: `PRD-${variables.query}`,
        usItemId: `US-${variables.query}`,
        offerId: `OFFER-${variables.query}`,
        name: `${variables.query} 1 kg`,
        availabilityStatusV2: { value: 'IN_STOCK' },
        priceInfo: { currentPrice: { price: 4 }, unitPrice: { priceString: '$0.40/100g' } }
      }] }] } }
    }, String(url));
  });
  const template = searchUrl({
    query: 'milk', page: 3, store: 'beta',
    searchArgs: { query: 'milk' },
    searchParams: { query: 'milk', page: 3, searchArgs: { query: 'milk' } }
  });

  await target.fetch(template, { headers: { 'x-o-platform': 'rweb' } });
  await vi.waitFor(() => expect(target[Symbol.for('walmart-price-per-unit.api-capture.v1')]
    .channel.snapshot()).toHaveLength(1));
  const result = await target[Symbol.for('walmart-price-per-unit.api-capture.v1')].queryProducts('eggs');

  expect(result.status).toBe('complete');
  expect(result.products[0]).toMatchObject({
    id: 'PRD-eggs',
    cartKey: 'w:US-eggs:OFFER-eggs',
    addable: true
  });
  const replay = new URL(requests.at(-1).url);
  const variables = JSON.parse(replay.searchParams.get('variables'));
  expect(variables).toMatchObject({
    query: 'eggs', page: 1,
    searchArgs: { query: 'eggs' },
    searchParams: { query: 'eggs', page: 1, searchArgs: { query: 'eggs' } }
  });
  expect(requests.at(-1).init.headers.get('x-o-segment')).toBe('oaoh');
});

it('adds and reviews the exact Walmart offer through APIs without navigating', async () => {
  const calls = [];
  const cartId = 'cart-fixture-1';
  let lines = [];
  const product = {
    id: 'PRD-eggs', usItemId: '10052944', offerId: 'OFFER-EGGS',
    name: 'Large Eggs 12 count', availabilityStatusV2: { value: 'IN_STOCK' },
    priceInfo: { currentPrice: { price: 4.18 }, unitPrice: { priceString: '$0.35/each' } }
  };
  const cartPayload = (field) => ({ data: { [field]: { id: cartId, lineItems: lines } } });
  const { target } = installCapture((url, init = {}) => {
    calls.push({ url: String(url), init });
    if (/MergeAndGetCart/i.test(String(url))) return jsonResponse(cartPayload('mergeAndGetCart'), String(url));
    if (/updateItems/i.test(String(url))) {
      const item = JSON.parse(init.body).variables.input.items[0];
      lines = [{ quantity: item.quantity, product: { offerId: item.offerId, usItemId: item.usItemId } }];
      return jsonResponse(cartPayload('updateItems'), String(url));
    }
    return jsonResponse({ data: { search: { itemStacks: [{ itemsV2: [product] }] } } }, String(url));
  });
  const capability = target[Symbol.for('walmart-price-per-unit.api-capture.v1')];
  const originalHref = target.location.href;

  await target.fetch(
    'https://www.walmart.ca/orchestra/graphql/MergeAndGetCart/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    { headers: { 'x-o-ccm': 'opaque-cart-context', 'x-o-correlation-id': 'stale-request-id' } }
  );
  await target.fetch(searchUrl({ query: 'milk', page: 1, store: 'beta' }));
  await vi.waitFor(() => expect(capability.channel.snapshot()).toHaveLength(1));
  const [captured] = capability.channel.snapshot();
  const added = await capability.addProduct(captured.cartKey, { name: captured.name });
  const review = await capability.readCart([captured.cartKey, 'w:missing:missing']);

  expect(added).toEqual({ status: 'added' });
  expect(review).toEqual({ inspectable: true, presentProductIds: [captured.cartKey] });
  expect(target.location.href).toBe(originalHref);
  const mutation = calls.find((call) => /updateItems/i.test(call.url));
  expect(JSON.parse(mutation.init.body).variables.input).toMatchObject({
    cartId,
    items: [{ offerId: product.offerId, usItemId: product.usItemId, quantity: 1, name: product.name }]
  });
  expect(mutation.init.headers.get('x-o-ccm')).toBe('opaque-cart-context');
  expect(mutation.init.headers.get('x-o-correlation-id')).toBeNull();
  expect(mutation.init.headers.get('x-o-gql-query')).toBe('mutation updateItems');
  const cartReads = calls.filter((call) => /MergeAndGetCart/i.test(call.url));
  expect(cartReads).toHaveLength(3);
  expect(cartReads.at(-1).init.headers.get('x-o-gql-query')).toBe('query MergeAndGetCart');
});

it('does not accept an optimistic Walmart update that was not persisted', async () => {
  const productKey = 'w:10052944:OFFER-EGGS';
  const { target } = installCapture((url, init = {}) => {
    if (/MergeAndGetCart/i.test(String(url))) {
      return jsonResponse({ data: { mergeAndGetCart: { id: 'cart-current', lineItems: [] } } }, String(url));
    }
    if (/updateItems/i.test(String(url))) {
      const item = JSON.parse(init.body).variables.input.items[0];
      return jsonResponse({ data: { updateItems: {
        id: 'cart-current', lineItems: [{ quantity: 1, product: item }]
      } } }, String(url));
    }
    return jsonResponse({}, String(url));
  });
  const capability = target[Symbol.for('walmart-price-per-unit.api-capture.v1')];
  await target.fetch(
    'https://www.walmart.ca/orchestra/graphql/MergeAndGetCart/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    { headers: { 'x-o-ccm': 'opaque-cart-context' } }
  );
  await vi.waitFor(async () => expect(await capability.readCart([])).not.toBeNull());

  await expect(capability.addProduct(productKey, { name: 'Eggs' }))
    .resolves.toEqual({ status: 'failed', reason: 'Walmart did not confirm this item in the cart.' });
  await expect(capability.readCart([productKey]))
    .resolves.toEqual({ inspectable: true, presentProductIds: [] });
});

it('rejects a Walmart cart response for a different cart', async () => {
  const productKey = 'w:10052944:OFFER-EGGS';
  const { target } = installCapture((url, init = {}) => {
    if (/MergeAndGetCart/i.test(String(url))) {
      return jsonResponse({ data: { mergeAndGetCart: { id: 'cart-current', lineItems: [] } } }, String(url));
    }
    if (/updateItems/i.test(String(url))) {
      const item = JSON.parse(init.body).variables.input.items[0];
      return jsonResponse({ data: { updateItems: {
        id: 'cart-other', lineItems: [{ quantity: 1, product: item }]
      } } }, String(url));
    }
    return jsonResponse({}, String(url));
  });
  const capability = target[Symbol.for('walmart-price-per-unit.api-capture.v1')];
  await target.fetch('https://www.walmart.ca/orchestra/graphql/MergeAndGetCart/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  await vi.waitFor(async () => expect(await capability.readCart([])).not.toBeNull());

  await expect(capability.addProduct(productKey, { name: 'Eggs' }))
    .resolves.toEqual({ status: 'failed', reason: 'Walmart did not confirm this item in the cart.' });
});
