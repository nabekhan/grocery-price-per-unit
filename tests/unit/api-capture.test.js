// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

const source = fs.readFileSync('src/retailers/loblaw/api-capture-main.js', 'utf8');

beforeEach(() => {
  window.history.replaceState({}, '', '/en/search?search-bar=milk&storeId=fixture-store');
  document.documentElement.innerHTML = '<head></head><body></body>';
  delete window[Symbol.for('rcss-price-per-unit.api-capture.v1')];
  window.fetch = vi.fn(async () => new Response('{}', { status: 200 }));
});

describe('RCSS main-world search capture', () => {
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
});
