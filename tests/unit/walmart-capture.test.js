import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

const source = `${fs.readFileSync('src/retailers/walmart/api-capture-main.js', 'utf8')
  .replace('export function installWalmartCapture', 'function installWalmartCapture')}\ninstallWalmartCapture(window);`;

function installCapture(response, pageUrl = 'https://www.walmart.ca/search?q=milk&store=beta') {
  const nativeFetch = vi.fn(async () => response);
  const target = {
    location: { href: pageUrl, origin: 'https://www.walmart.ca' },
    document: {
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
    encodeURIComponent
  });
  return { target, nativeFetch };
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
