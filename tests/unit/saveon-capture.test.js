// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';

const source = fs.readFileSync('src/retailers/saveon/api-capture-main.js', 'utf8');

beforeEach(() => {
  window.history.replaceState({}, '', '/sm/pickup/rsid/6632/results?q=eggs');
  delete window[Symbol.for('saveon-price-per-unit.api-capture.v1')];
  delete window.__PRELOADED_STATE__;
  window.fetch = vi.fn(async () => new Response('{}', { status: 200 }));
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

it('captures Save-On page-2 products loaded through XMLHttpRequest', async () => {
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
