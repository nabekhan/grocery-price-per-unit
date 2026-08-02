import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const fixture = path.join(root, 'tests/fixtures/product-grid.html');
const fixtureHtml = await fs.readFile(fixture, 'utf8');
const contentScript = await fs.readFile(path.join(root, 'dist/extension/loblaw-content.js'), 'utf8');
const captureScript = await fs.readFile(path.join(root, 'dist/extension/loblaw-api-capture-main.js'), 'utf8');
const tile = (productId, title, packageSizing, price, extra = {}) => ({
  productId, title, packageSizing, pricing: { price: price == null ? null : String(price), displayPrice: price == null ? null : `$${Number(price).toFixed(2)}` }, link: `/product/${productId}`, ...extra
});
const INITIAL_TILES = [
  tile('flour', 'Flour', '1 kg, $0.60/100g', 5.96),
  tile('milk', 'Milk', '4 L, $0.16/100ml', 6.44),
  tile('rice', 'Rice sale', '2 kg', 4),
  tile('chicken', 'Chicken', 'approximately 800 g, $10.88/1lb', 12),
  tile('eggs', 'Eggs', '12 count', 6),
  tile('cans', 'Cans', '6 x 355 mL', 12),
  tile('conditional', 'Conditional', '1 ea', null),
  tile('mystery', 'Mystery', 'family size', 8)
];
const responseFor = (tiles, query = null) => ({ ...(query ? { searchTermSubmitted: query } : {}), layout: { sections: { mainContentCollection: { components: [{ data: { productTiles: tiles } }] } } } });
const openFixture = async (page, query = '', origin = 'https://www.realcanadiansuperstore.ca') => {
  await page.route(`${origin}/test-fixture*`, (route) => route.fulfill({ body: fixtureHtml, contentType: 'text/html' }));
  await page.goto(`${origin}/test-fixture${query}`);
};
const install = async (page, tiles = INITIAL_TILES, query = null) => {
  await page.evaluate((payload) => {
    const script = document.createElement('script');
    script.id = '__NEXT_DATA__';
    script.type = 'application/json';
    script.textContent = JSON.stringify({ props: { pageProps: { initialSearchData: payload } } });
    document.body.append(script);
  }, responseFor(tiles, query));
  await page.addScriptTag({ content: captureScript });
  await page.addScriptTag({ content: contentScript });
};
const choose = async (page, value) => {
  await page.locator('#lups-menu-button').click();
  await page.locator(`[data-lups-value="${value}"]`).click();
};

test('sorts, reverses, restores, and incorporates appended products', async ({ page }) => {
  const scriptErrors = [];
  page.on('pageerror', (error) => scriptErrors.push(error.message));
  await openFixture(page);
  await install(page);
  await choose(page, 'mass-asc');
  const control = page.locator('#lups-control');
  await expect(control).toHaveCount(1);
  await choose(page, 'mass-asc');
  await expect(control.locator('output')).toContainText('Sorted 3 products by $/kg');

  const visualOrder = async () => page.locator('#grid > div').evaluateAll((cards) => cards
    .map((card) => ({ id: card.dataset.fixtureId, order: Number(getComputedStyle(card).order) }))
    .sort((a, b) => a.order - b.order).map((item) => item.id));
  expect((await visualOrder()).slice(0, 3)).toEqual(['mass-sale', 'mass-explicit', 'weighted']);

  await choose(page, 'mass-desc');
  expect((await visualOrder()).slice(0, 3)).toEqual(['weighted', 'mass-explicit', 'mass-sale']);
  expect(await page.locator('#grid > div').count()).toBe(8);
  await expect(page.locator('a[href="/product/flour"]')).toHaveAttribute('href', '/product/flour');
  await expect(page.getByRole('button', { name: 'Add Flour to cart' })).toBeEnabled();

  await page.locator('#grid').evaluate((grid) => grid.insertAdjacentHTML('beforeend', '<div data-fixture-id="appended"><div data-testid="price-product-tile"><span data-testid="regular-price">$1.00</span></div><h3 data-testid="product-title">Appended</h3><p data-testid="product-package-size">1 kg</p><a href="/product/appended">Appended</a></div>'));
  await page.route('https://api.pcexpress.ca/pcx-bff/api/v2/products/search', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify(responseFor([tile('appended', 'Appended', '1 kg', 1)]))
  }));
  await page.evaluate(() => fetch('https://api.pcexpress.ca/pcx-bff/api/v2/products/search', {
    method: 'POST', body: JSON.stringify({ listingInfo: { filters: {}, pagination: { from: 8 } } })
  }));
  await expect(control.locator('output')).toContainText('Sorted 4 products');
  expect((await visualOrder()).slice(0, 4)).toEqual(['weighted', 'mass-explicit', 'mass-sale', 'appended']);
  await expect(page.locator('#lups-control')).toHaveCount(1);

  await choose(page, 'restore');
  await expect(control.locator('output')).toContainText('Website order restored for 9 loaded products');
  expect(await page.locator('#grid > div').evaluateAll((cards) => cards.every((card) => !card.style.order))).toBe(true);
  expect(scriptErrors).toEqual([]);
});

test('automatic mode falls back to displayed total price only on a unitless page', async ({ page }) => {
  await openFixture(page);
  await install(page);
  await choose(page, 'mass-asc');
  await page.locator('#grid').evaluate((grid) => {
    grid.innerHTML = [
      ['nine', '$9.00'], ['two', '$2.00'], ['missing', 'See price in cart']
    ].map(([id, price]) => `<div data-fixture-id="${id}"><div data-testid="price-product-tile"><span data-testid="regular-price">${price}</span></div><h3 data-testid="product-title">${id}</h3><p data-testid="product-package-size">assorted style</p><a href="/product/${id}">${id}</a></div>`).join('');
  });
  const unitless = [tile('nine', 'nine', 'assorted style', 9), tile('two', 'two', 'assorted style', 2), tile('missing', 'missing', 'assorted style', null)];
  await page.route('https://api.pcexpress.ca/pcx-bff/api/v2/products/search', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(responseFor(unitless)) }));
  await page.evaluate(() => fetch('https://api.pcexpress.ca/pcx-bff/api/v2/products/search', { method: 'POST', body: JSON.stringify({ listingInfo: { filters: {} } }) }));
  await choose(page, 'auto-asc');
  await expect(page.locator('#lups-status')).toContainText('total price (unit prices unavailable');
  const order = await page.locator('#grid > div').evaluateAll((cards) => cards.map((card) => ({ id: card.dataset.fixtureId, order: Number(getComputedStyle(card).order) })).sort((a, b) => a.order - b.order).map((item) => item.id));
  expect(order).toEqual(['two', 'nine', 'missing']);
});

test('fits a narrow mobile viewport and remains keyboard accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFixture(page);
  await install(page);
  await page.locator('#lups-menu-button').focus();
  await expect(page.locator('#lups-menu-button')).toBeFocused();
  const box = await page.locator('#lups-control').boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'artifacts/screenshots/fixture-mobile.png', fullPage: true });
});

test('unit price menu stays polished and contained across viewports', async ({ page }) => {
  const viewports = [
    { name: 'phone-390', width: 390, height: 844 },
    { name: 'tablet-768', width: 768, height: 900 },
    { name: 'desktop-1440', width: 1440, height: 900 }
  ];

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await openFixture(page);
    await install(page);
    await page.locator('#lups-menu-button').click();

    const button = await page.locator('#lups-menu-button').boundingBox();
    const menu = await page.locator('#lups-menu-host').boundingBox();
    expect(button.x).toBeGreaterThanOrEqual(0);
    expect(button.x + button.width).toBeLessThanOrEqual(viewport.width);
    expect(menu.x).toBeGreaterThanOrEqual(0);
    expect(menu.x + menu.width).toBeLessThanOrEqual(viewport.width);
    expect(menu.y).toBeGreaterThanOrEqual(0);
    expect(menu.y + menu.height).toBeLessThanOrEqual(viewport.height);
    await expect(page.locator('#lups-menu [data-lups-value]')).toHaveCount(11);
    await page.screenshot({
      path: `artifacts/screenshots/selector-viewports/${viewport.name}.png`,
      fullPage: false
    });
  }
});

test('mounts independently from a retailer toolbar', async ({ page }) => {
  await openFixture(page);
  const toolbarHtml = await page.locator('#toolbar').evaluate((toolbar) => toolbar.outerHTML);
  await page.locator('#toolbar').evaluate((toolbar) => toolbar.remove());
  await install(page);
  await expect(page.locator('#lups-control')).toHaveCount(1);
  await expect(page.locator('#lups-control')).toHaveAttribute('data-lups-floating', 'true');

  await page.locator('body').evaluate((body, html) => body.insertAdjacentHTML('afterbegin', html), toolbarHtml);
  await expect(page.locator('#lups-control')).toHaveCount(1);
});

test('uses the same API-first flow on No Frills', async ({ page }) => {
  await openFixture(page, '?search-bar=milk', 'https://www.nofrills.ca');
  await install(page, INITIAL_TILES, 'milk');
  await choose(page, 'volume-asc');
  await expect(page.locator('#lups-control')).toHaveCount(1);
  await expect(page.locator('#lups-control')).toHaveAttribute('data-lups-floating', 'true');
  await expect(page.locator('[data-fixture-id="volume-explicit"]')).toHaveAttribute('data-lups-data-source', 'api');
  await expect(page.locator('[data-fixture-id="volume-explicit"] [data-lups-annotation]')).toContainText('retailer API');
});

test('sorts every card returned by the scoped RCSS search API', async ({ page }) => {
  await openFixture(page, '?search-bar=milk');
  await install(page, INITIAL_TILES, 'milk');
  await choose(page, 'volume-asc');
  await expect(page.locator('#lups-status')).toContainText('8 loaded products total');
  await expect(page.locator('[data-fixture-id="volume-explicit"] [data-lups-annotation]')).toHaveCount(1);
  await expect(page.locator('[data-fixture-id="mass-explicit"] [data-lups-annotation]')).toHaveCount(1);
  await expect(page.locator('[data-fixture-id="unknown"]')).toHaveCSS('order', '7');
});

test('reinjects after Loblaw replaces the complete page content during SPA navigation', async ({ page }) => {
  await openFixture(page);
  await install(page);
  await expect(page.locator('#lups-control')).toHaveCount(1);
  await page.evaluate(() => {
    document.querySelector('#toolbar').remove();
    document.querySelector('main').remove();
    document.body.insertAdjacentHTML('beforeend', `
      <div id="toolbar"><section><div><label data-testid="sort-label"><p>Sort</p></label><button data-testid="menu-button"><span><p>Relevance</p></span></button></div></section></div>
      <main><div id="grid">${Array.from({ length: 3 }, (_, index) => `<div><div data-testid="price-product-tile"><span data-testid="regular-price">$${index + 1}.00</span></div><h3 data-testid="product-title">Replacement ${index}</h3><p data-testid="product-package-size">1 ea</p><a href="/product/replacement-${index}">Item</a></div>`).join('')}</div></main>`);
  });
  await expect(page.locator('#lups-control')).toHaveCount(1);
  await expect(page.locator('#lups-control')).toHaveAttribute('data-lups-floating', 'true');
});

test('does not replace API package data with silently changed card text', async ({ page }) => {
  await openFixture(page);
  await install(page);
  const annotation = page.locator('[data-fixture-id="mass-explicit"] [data-lups-annotation]');
  await expect(annotation).toContainText('6.00 $/kg');
  await page.locator('[data-fixture-id="mass-explicit"] [data-testid="product-package-size"]').evaluate((node) => {
    node.firstChild.data = '1 kg, $0.40/100g';
  });
  await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
  await expect(annotation).toContainText('6.00 $/kg');
  await expect(page.locator('[data-fixture-id="mass-explicit"]')).toHaveAttribute('data-lups-data-source', 'api');
});

test('sorts across multiple lazy-loaded Loblaw grid chunks and restores each chunk', async ({ page }) => {
  await openFixture(page);
  await page.evaluate(() => {
    const main = document.querySelector('main');
    main.dataset.testid = 'listing-page-container';
    const first = document.querySelector('#grid');
    first.dataset.testid = 'product-grid-component';
    const second = first.cloneNode(false);
    second.id = 'grid-2';
    second.dataset.testid = 'product-grid-component';
    for (const card of [...first.children].slice(2)) second.append(card);
    main.append(second);
  });
  await install(page);
  await choose(page, 'mass-asc');
  await expect(page.locator('#grid > [data-fixture-id="mass-sale"]')).toHaveCount(1);
  await expect(page.locator('#grid > [data-fixture-id="mass-explicit"]')).toHaveCount(1);
  await expect(page.locator('#grid > [data-fixture-id="weighted"]')).toHaveCount(1);
  await expect(page.locator('#grid-2 > *')).toHaveCount(0);
  await choose(page, 'restore');
  await expect(page.locator('#grid')).toHaveCount(1);
  await expect(page.locator('#grid-2 > *')).toHaveCount(6);
});
