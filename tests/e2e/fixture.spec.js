import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { captureControlStateMatrix, captureForcedColorsControl, expectControlStateMatrix } from './control-state-matrix.js';

const root = process.cwd();
const fixture = path.join(root, 'tests/fixtures/product-grid.html');
const fixtureHtml = await fs.readFile(fixture, 'utf8');
const visualFixtureHtml = await fs.readFile(path.join(root, 'tests/fixtures/visual-marketplace-shell.html'), 'utf8');
const userscript = await fs.readFile(path.join(root, 'dist/userscript/Grocery Price Per Unit.user.js'), 'utf8');
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
const INITIAL_API_PRODUCTS = Object.fromEntries(INITIAL_TILES.map((product) => [product.productId, {
  id: product.productId,
  name: product.title,
  packageSizing: product.packageSizing,
  currentPrice: product.pricing.price === null ? null : Number(product.pricing.price),
  regularPrice: product.pricing.wasPrice == null ? null : Number(product.pricing.wasPrice),
  displayPrice: product.pricing.displayPrice || null,
  weighted: product.pricingUnits?.weighted ?? null
}]));
const responseFor = (tiles, query = null) => ({ ...(query ? { searchTermSubmitted: query } : {}), layout: { sections: { mainContentCollection: { components: [{ data: { productTiles: tiles } }] } } } });
const openFixture = async (page, query = '', origin = 'https://www.realcanadiansuperstore.ca') => {
  await page.route(`${origin}/test-fixture*`, (route) => route.fulfill({ body: fixtureHtml, contentType: 'text/html' }));
  await page.goto(`${origin}/test-fixture${query}`);
};
const openVisualFixture = async (page) => {
  await page.route('https://www.realcanadiansuperstore.ca/visual-control-fixture*', (route) => route.fulfill({
    body: visualFixtureHtml,
    contentType: 'text/html'
  }));
  await page.goto('https://www.realcanadiansuperstore.ca/visual-control-fixture?search-bar=milk');
};
const install = async (page, tiles = INITIAL_TILES, query = null) => {
  await page.evaluate((payload) => {
    const script = document.createElement('script');
    script.id = '__NEXT_DATA__';
    script.type = 'application/json';
    script.textContent = JSON.stringify({ props: { pageProps: { initialSearchData: payload } } });
    document.body.append(script);
  }, responseFor(tiles, query));
  await page.addScriptTag({ content: userscript });
};
const choose = async (page, value) => {
  await page.locator('#lups-menu-button').click();
  await page.locator(`[data-lups-value="${value}"]`).click();
};

for (const storefront of [
  { name: 'Superstore', origin: 'https://www.realcanadiansuperstore.ca' },
  { name: 'No Frills', origin: 'https://www.nofrills.ca' }
]) {
  test(`${storefront.name} hides only exact recognized sponsored product cards and restores recycled cards`, async ({ page }) => {
    await fs.mkdir(path.join(root, 'artifacts/screenshots/loblaw-promotions'), { recursive: true });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await openFixture(page, '?search-bar=milk', storefront.origin);
    await page.locator('#grid').evaluate((grid) => {
      const base = document.createElement('base');
      base.href = 'https://example.com/catalog/';
      document.head.append(base);
      grid.insertAdjacentHTML('afterbegin', `
        <div data-fixture-id="recognized-sponsored" style="display:grid">
          <div data-testid="price-product-tile"><span data-testid="regular-price">$3.00</span></div>
          <h3 data-testid="product-title">Recognized promotion</h3>
          <p data-testid="product-package-size">1 kg</p>
          <span> Sponsored </span>
          <a href="${location.origin}/product/recognized-sponsored?source=sptd">Recognized product link</a>
          <button>Inspect recognized product</button>
        </div>
        <div data-fixture-id="marker-only"><h3 data-testid="product-title">Marker only</h3><span>Sponsored</span><a href="${location.origin}/product/marker-only">Marker-only product</a></div>
        <div data-fixture-id="tracking-only"><h3 data-testid="product-title">Tracking only</h3><a href="${location.origin}/product/tracking-only?source=sptd">Tracking-only product</a></div>
        <div data-fixture-id="title-contains"><h3 data-testid="product-title">Sponsored pantry savings</h3><a href="${location.origin}/product/title-contains?source=sptd">Title product</a></div>
        <div data-fixture-id="utm-only"><h3 data-testid="product-title">UTM only</h3><span>Sponsored</span><a href="${location.origin}/product/utm-only?utm_source=sptd">UTM product</a></div>
        <div data-fixture-id="near-match"><h3 data-testid="product-title">Near match</h3><span>Sponsored</span><a href="${location.origin}/product/near-match?source=sptd-extra">Near-match product</a></div>
        <div data-fixture-id="foreign-origin"><h3 data-testid="product-title">Foreign origin</h3><span>Sponsored</span><a href="https://example.com/product/foreign?source=sptd">Foreign product</a></div>
        <div data-fixture-id="link-text-sponsored"><h3 data-testid="product-title">Ordinary link label</h3><a href="${location.origin}/product/link-text-sponsored?source=sptd">Sponsored</a></div>
        <div data-fixture-id="exact-title-sponsored"><h3 data-testid="product-title">Sponsored</h3><a href="${location.origin}/product/exact-title-sponsored?source=sptd">Ordinary title product</a></div>
        <div data-fixture-id="button-text-sponsored"><h3 data-testid="product-title">Ordinary button label</h3><button>Sponsored</button><a href="${location.origin}/product/button-text-sponsored?source=sptd">Ordinary button product</a></div>
        <div data-fixture-id="foreign-base-relative"><h3 data-testid="product-title">Foreign base relative</h3><span>Sponsored</span><a href="go/product/foreign-base-relative?source=sptd">Foreign base product</a></div>
        <div data-fixture-id="duplicate-source"><h3 data-testid="product-title">Duplicate source</h3><span>Sponsored</span><a href="${location.origin}/product/duplicate-source?source=sptd&amp;source=organic">Duplicate-source product</a></div>
      `);
      const outside = document.createElement('aside');
      outside.dataset.fixtureId = 'outside-grid';
      outside.innerHTML = '<h3 data-testid="product-title">Outside grid</h3><span>Sponsored</span><a href="/product/outside?source=sptd">Outside product</a>';
      document.body.append(outside);
      window.__recognizedSponsoredCard = grid.querySelector('[data-fixture-id="recognized-sponsored"]');
    });
    await install(page, [
      ...INITIAL_TILES,
      tile('recognized-sponsored', 'Recognized promotion', '1 kg', 3)
    ], 'milk');

    const recognized = page.locator('[data-fixture-id="recognized-sponsored"]');
    await expect(recognized).toHaveCSS('display', 'none');
    await expect(recognized.locator('[data-lups-annotation]')).toHaveCount(0);
    await expect(recognized.locator('a')).toHaveAttribute('href', `${storefront.origin}/product/recognized-sponsored?source=sptd`);
    await expect(recognized.locator('button')).toHaveCount(1);
    expect(await recognized.locator('button').evaluate((button) => !button.disabled)).toBe(true);
    await expect(page.locator('#lups-status')).toContainText('1 sponsored/ad tile hidden');
    for (const id of ['marker-only', 'tracking-only', 'title-contains', 'utm-only', 'near-match', 'foreign-origin', 'link-text-sponsored', 'exact-title-sponsored', 'button-text-sponsored', 'foreign-base-relative', 'duplicate-source', 'outside-grid']) {
      await expect(page.locator(`[data-fixture-id="${id}"]`)).toBeVisible();
    }

    await choose(page, 'auto-asc');
    await choose(page, 'restore');
    await expect(recognized).toHaveCSS('display', 'none');
    await page.locator('#lups-menu-button').hover();
    await expect(page.locator('#lups-status-row')).toBeVisible();
    await expect(page.locator('#lups-status')).toHaveText('Website order · 19 loaded products · 1 sponsored/ad tile hidden');
    await expect(page.locator('#lups-menu-button')).not.toHaveAttribute('title');
    await expect(page.locator('#lups-restore')).toHaveCount(0);
    await page.setViewportSize({ width: 320, height: 700 });
    expect(await page.locator('#lups-status-row').evaluate((row) => {
      const box = row.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && row.scrollWidth <= Math.ceil(box.width);
    })).toBe(true);
    expect(await page.evaluate(() => window.__recognizedSponsoredCard === document.querySelector('[data-fixture-id="recognized-sponsored"]'))).toBe(true);
    await page.screenshot({
      path: `artifacts/screenshots/loblaw-promotions/${storefront.name.toLowerCase().replace(' ', '-')}-filtered.png`,
      fullPage: true
    });

    await recognized.locator('span', { hasText: /^ Sponsored $/ }).evaluate((marker) => marker.remove());
    await expect(recognized).toHaveCSS('display', 'grid');
    await expect(recognized.locator('[data-lups-annotation]')).toHaveText('$3.00/kg · Calculated');
    await page.locator('h1').click();
    await expect(page.locator('#lups-status-row')).toBeHidden();
    await expect(page.locator('#lups-status')).not.toContainText('sponsored/ad tile hidden');

    await recognized.evaluate((card) => {
      card.insertAdjacentHTML('beforeend', '<span>Sponsored</span>');
      card.querySelector('a').setAttribute('href', `${location.origin}/product/recognized-sponsored?source=sptc`);
      window.__recognizedAnnotationNode = card.querySelector('[data-lups-annotation]');
    });
    await expect(recognized).toHaveCSS('display', 'none');
    expect(await recognized.evaluate((card) => card.querySelector('[data-lups-annotation]') === window.__recognizedAnnotationNode)).toBe(true);
    await recognized.evaluate((card) => document.querySelector('aside').append(card));
    await expect(recognized).toHaveCSS('display', 'grid');
    await expect(recognized.locator('[data-lups-annotation]')).toHaveCount(0);
    await expect(recognized).not.toHaveAttribute('data-lups-data-source', /.+/);
    await recognized.evaluate((card) => {
      document.querySelector('#grid').append(card);
      card.querySelector('a').setAttribute('href', `${location.origin}/product/recognized-sponsored?source=organic`);
    });
    await expect(recognized).toHaveCSS('display', 'grid');
    await expect(recognized.locator('[data-lups-annotation]')).toHaveText('$3.00/kg · Calculated');

    await page.locator('#grid').evaluate((grid) => grid.insertAdjacentHTML('beforeend', `
      <div data-fixture-id="dynamic-sponsored">
        <h3 data-testid="product-title">Dynamic promotion</h3>
        <span>Sponsored</span>
        <a href="${location.origin}/product/dynamic-sponsored?source=SPTC">Dynamic product</a>
      </div>
    `));
    const dynamic = page.locator('[data-fixture-id="dynamic-sponsored"]');
    await expect(dynamic).toHaveCSS('display', 'none');
    await expect(page.locator('#lups-status')).toContainText('1 sponsored/ad tile hidden');
    await dynamic.locator('span').evaluate((marker) => marker.firstChild.data = 'Featured');
    await expect(dynamic).toBeVisible();
    await expect(page.locator('#lups-status')).not.toContainText('sponsored/ad tile hidden');
    await page.screenshot({
      path: `artifacts/screenshots/loblaw-promotions/${storefront.name.toLowerCase().replace(' ', '-')}-restored.png`,
      fullPage: true
    });

    await recognized.locator('a').evaluate((link) => link.setAttribute('href', `${location.origin}/product/recognized-sponsored?source=sptd`));
    await expect(recognized).toHaveCSS('display', 'none');
    await page.locator('#grid').evaluate((grid) => {
      const keep = grid.querySelector('[data-fixture-id="recognized-sponsored"]');
      grid.replaceChildren(keep);
    });
    await expect(recognized).toHaveCSS('display', 'grid');
    await recognized.locator('a').evaluate((link) => link.setAttribute('href', `${location.origin}/product/recognized-sponsored?source=organic`));
    await expect(recognized).toHaveCSS('display', 'grid');
    expect(pageErrors).toEqual([]);
  });
}

test('sorts, reverses, restores, and incorporates appended products', async ({ page }) => {
  const scriptErrors = [];
  page.on('pageerror', (error) => scriptErrors.push(error.message));
  await openFixture(page);
  await install(page);
  await choose(page, 'mass-asc');
  const control = page.locator('#lups-control');
  await expect(control).toHaveCount(1);
  await choose(page, 'mass-asc');
  await expect(control.locator('#lups-status')).toContainText('3 comparable');
  await expect(control.locator('#lups-status')).not.toContainText('Sorted by');
  await expect(control.locator('#lups-live-status')).toContainText('Sorted by $/kg · Low → high · 3 comparable');
  await expect(control.locator('#lups-status')).toContainText('Loaded range $2.00–$23.99/kg');
  const calculatedAnnotation = page.locator('[data-fixture-id="mass-sale"] [data-lups-annotation]');
  await expect(calculatedAnnotation).toHaveText('$2.00/kg · Calculated');
  await expect(calculatedAnnotation).toHaveAttribute('aria-label', '$2.00 per kilogram, calculated from retailer API package and price data');
  await expect(control.locator('#lups-status')).toContainText('3 comparable');
  await expect(page.locator('#lups-restore')).toHaveCount(0);
  await expect(page.locator('#lups-flip-direction')).toBeVisible();
  await expect(page.locator('#lups-flip-direction')).toHaveAttribute('aria-label', 'Reverse unit-price order to high to low');

  const visualOrder = async () => page.locator('#grid > div').evaluateAll((cards) => cards
    .map((card) => ({ id: card.dataset.fixtureId, order: Number(getComputedStyle(card).order) }))
    .sort((a, b) => a.order - b.order).map((item) => item.id));
  expect((await visualOrder()).slice(0, 3)).toEqual(['mass-sale', 'mass-explicit', 'weighted']);

  await page.locator('#lups-flip-direction').click();
  await expect(page.locator('#lups-menu-button')).toBeFocused();
  await expect(page.locator('#lups-mode')).toHaveValue('mass-desc');
  await expect(page.locator('#lups-flip-direction')).toHaveAttribute('aria-label', 'Reverse unit-price order to low to high');
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
  await expect(control.locator('#lups-status')).toContainText('4 comparable');
  await expect(control.locator('#lups-live-status')).toContainText('Sorted by $/kg · High → low · 4 comparable');
  await expect(control.locator('#lups-status')).toContainText('Loaded range $1.00–$23.99/kg');
  expect((await visualOrder()).slice(0, 4)).toEqual(['weighted', 'mass-explicit', 'mass-sale', 'appended']);
  await expect(page.locator('#lups-control')).toHaveCount(1);

  await choose(page, 'restore');
  await expect(control.locator('#lups-live-status')).toContainText('Website order · 9 loaded products');
  await page.locator('#lups-menu-button').hover();
  await expect(page.locator('#lups-status-row')).toBeVisible();
  await expect(page.locator('#lups-flip-direction')).toBeHidden();
  await expect(page.locator('#lups-restore')).toHaveCount(0);
  expect(await page.locator('#grid > div').evaluateAll((cards) => cards.every((card) => !card.style.order))).toBe(true);
  expect(scriptErrors).toEqual([]);
});

test('Loblaw preserves native order across sort cycles and releases a connected former grid', async ({ page }) => {
  await openFixture(page);
  await page.evaluate(() => {
    const listing = document.querySelector('main');
    listing.dataset.testid = 'listing-page-container';
    const first = document.querySelector('#grid');
    first.dataset.testid = 'product-grid-component';
    const second = first.cloneNode(false);
    second.id = 'native-grid-2';
    second.dataset.testid = 'product-grid-component';
    for (const card of [...first.children].slice(2)) second.append(card);
    listing.append(second);
  });
  const nativeCard = page.locator('[data-fixture-id="mass-explicit"]');
  const retailerRelocatedCard = page.locator('[data-fixture-id="mass-sale"]');
  await nativeCard.evaluate((card) => card.style.setProperty('order', '7'));
  await install(page);
  await expect(nativeCard.locator('[data-lups-annotation]')).toHaveCount(1);
  await expect.poll(() => nativeCard.evaluate((card) => card.style.order)).toBe('7');
  await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
  await expect.poll(() => nativeCard.evaluate((card) => card.style.order)).toBe('7');

  await choose(page, 'mass-asc');
  await expect.poll(() => nativeCard.evaluate((card) => card.style.order)).not.toBe('7');
  await choose(page, 'restore');
  await expect.poll(() => nativeCard.evaluate((card) => card.style.order)).toBe('7');

  await nativeCard.evaluate((card) => card.style.setProperty('order', '9'));
  await choose(page, 'mass-asc');
  await choose(page, 'restore');
  await expect.poll(() => nativeCard.evaluate((card) => card.style.order)).toBe('9');

  await choose(page, 'mass-asc');
  await page.evaluate(() => {
    const retailerRegion = document.createElement('aside');
    retailerRegion.id = 'retailer-region';
    retailerRegion.append(document.querySelector('[data-fixture-id="mass-sale"]'));
    document.body.append(retailerRegion);
    document.querySelector('[data-testid="listing-page-container"]').removeAttribute('data-testid');
    const listing = document.createElement('section');
    listing.dataset.testid = 'listing-page-container';
    listing.innerHTML = `<div id="replacement-grid" data-testid="product-grid-component">
      ${[1, 2, 3].map((index) => `<div data-fixture-id="replacement-${index}"><h3 data-testid="product-title">Replacement ${index}</h3><a href="/product/replacement-${index}">Replacement</a></div>`).join('')}
    </div>`;
    document.body.append(listing);
  });

  await expect(page.locator('#replacement-grid [data-lups-data-source]')).toHaveCount(3);
  await expect(nativeCard).toBeAttached();
  await expect(nativeCard).toHaveAttribute('style', /order:\s*9/);
  await expect(nativeCard.locator('[data-lups-annotation]')).toHaveCount(0);
  await expect(nativeCard).not.toHaveAttribute('data-lups-data-source', /.+/);
  await expect(page.locator('#retailer-region > [data-fixture-id="mass-sale"]')).toHaveCount(1);
  await expect(retailerRelocatedCard.locator('[data-lups-annotation]')).toHaveCount(0);
  await expect(retailerRelocatedCard).not.toHaveAttribute('data-lups-data-source', /.+/);
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
  await expect(page.locator('#lups-status')).not.toContainText('Automatic chose');
  await expect(page.locator('#lups-live-status')).toContainText('Automatic chose total price · Low → high');
  await expect(page.locator('#lups-status')).toContainText('Loaded range $2.00–$9.00');
  await expect(page.locator('#lups-status')).toContainText('no comparable unit prices available');
  await expect(page.locator('#lups-menu-button-text')).toHaveText('Auto · total price · Low → high');
  const order = await page.locator('#grid > div').evaluateAll((cards) => cards.map((card) => ({ id: card.dataset.fixtureId, order: Number(getComputedStyle(card).order) })).sort((a, b) => a.order - b.order).map((item) => item.id));
  expect(order).toEqual(['two', 'nine', 'missing']);
});

test('fits a narrow mobile viewport and remains keyboard accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFixture(page);
  await install(page);
  const trigger = page.locator('#lups-menu-button');
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
  await expect(trigger).toHaveAttribute('aria-controls', 'lups-menu');
  await expect(trigger).toHaveAttribute('aria-describedby', 'lups-status');
  await expect(trigger).toHaveAccessibleName('Unit price Website order');
  expect((await trigger.boundingBox()).width).toBeGreaterThanOrEqual(44);
  expect((await trigger.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await expect(page.locator('#lups-status-row')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('menuitemradio', { name: 'Website order, Keep the retailer’s current order' })).toBeFocused();
  await expect(page.locator('[role="menuitemradio"][aria-checked="true"]')).toHaveCount(1);
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-lups-value="auto-asc"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(trigger).toBeFocused();
  await expect(page.locator('#lups-mode')).toHaveValue('auto-asc');
  await expect(trigger).toHaveAccessibleName('Unit price Auto · $/kg · Low → high');
  expect((await page.locator('#lups-flip-direction').boundingBox()).height).toBeGreaterThanOrEqual(44);
  await trigger.click();
  await expect(page.locator('#lups-menu')).toHaveAttribute('role', 'menu');
  await expect(page.locator('#lups-menu [role="menuitemradio"]')).toHaveCount(6);
  await expect(page.locator('#lups-default')).toBeVisible();
  expect(await page.locator('#lups-default').evaluate((item) => item.closest('[role="menu"]')?.id)).toBe('lups-menu');
  for (const item of await page.locator('#lups-menu [role="menuitemradio"],#lups-default').all()) {
    const target = await item.boundingBox();
    expect(target.width).toBeGreaterThanOrEqual(44);
    expect(target.height).toBeGreaterThanOrEqual(44);
    expect(target.x).toBeGreaterThanOrEqual(0);
    expect(target.x + target.width).toBeLessThanOrEqual(390);
  }
  await page.keyboard.press('End');
  await expect(page.locator('#lups-default')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#lups-default')).toContainText('Default saved');
  await expect.poll(() => page.evaluate(() => localStorage.getItem(
    '__gppu_userscript_storage__:sync:defaultSortMode'
  ))).toBe('"auto-asc"');
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await choose(page, 'restore');
  await expect(page.locator('#lups-mode')).toHaveValue('restore');
  await expect(page.locator('#lups-restore')).toHaveCount(0);
  const box = await page.locator('#lups-control').boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'artifacts/screenshots/fixture-mobile.png', fullPage: true });
});

test('unit price menu stays polished and contained across viewports', async ({ page }) => {
  const viewports = [
    { name: 'phone-320', width: 320, height: 844 },
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
    expect(menu.y + menu.height).toBeLessThanOrEqual(button.y + 1);
    expect(button.y - (menu.y + menu.height)).toBeGreaterThanOrEqual(7);
    expect(button.y - (menu.y + menu.height)).toBeLessThanOrEqual(13);
    await expect(page.locator('#lups-menu [data-lups-value]')).toHaveCount(6);

    await page.locator('[data-lups-value="auto-asc"]').click();
    await page.locator('#lups-menu-button').click();
    const activeButton = await page.locator('#lups-menu-button').boundingBox();
    const activeMenu = await page.locator('#lups-menu-host').boundingBox();
    expect(activeButton.y - (activeMenu.y + activeMenu.height)).toBeGreaterThanOrEqual(7);
    expect(activeButton.y - (activeMenu.y + activeMenu.height)).toBeLessThanOrEqual(13);
    await page.screenshot({
      path: `artifacts/screenshots/selector-viewports/${viewport.name}.png`,
      fullPage: false
    });
  }
});

test('lifts above broad bottom obstructions without interacting with them', async ({ page }) => {
  const outputDirectory = path.join(root, 'artifacts/screenshots/control-obstruction');
  await fs.mkdir(outputDirectory, { recursive: true });
  const viewports = [
    { name: 'phone-390', width: 390, height: 844, obstructionHeight: 120, baselineBottom: 14 },
    { name: 'tablet-768', width: 768, height: 900, obstructionHeight: 100, baselineBottom: 18 },
    { name: 'desktop-1440', width: 1440, height: 900, obstructionHeight: 92, baselineBottom: 18 }
  ];

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await openFixture(page);
    await install(page);
    await page.locator('#lups-menu-button').focus();
    await page.evaluate((height) => {
      const obstruction = document.createElement('div');
      obstruction.id = 'lups-test-obstruction';
      obstruction.dataset.untouched = 'true';
      obstruction.style.cssText = `position:fixed;inset:auto 0 0 0;height:${height}px;background:#fff4d6;z-index:2147483000;pointer-events:auto`;
      document.body.append(obstruction);
      window.__lupsObstructionMutations = 0;
      new MutationObserver((records) => { window.__lupsObstructionMutations += records.length; })
        .observe(obstruction, { attributes: true, childList: true, subtree: true });
    }, viewport.obstructionHeight);

    await expect(page.locator('#lups-control')).toHaveAttribute('data-lups-obstructed', 'true');
    await expect(page.locator('#lups-menu-button')).toBeFocused();
    await expect.poll(async () => {
      const controlBox = await page.locator('#lups-control').boundingBox();
      const obstructionBox = await page.locator('#lups-test-obstruction').boundingBox();
      return controlBox.y + controlBox.height <= obstructionBox.y - 11;
    }).toBe(true);
    const control = await page.locator('#lups-control').boundingBox();
    const obstruction = await page.locator('#lups-test-obstruction').boundingBox();
    expect(control.y + control.height).toBeLessThanOrEqual(obstruction.y - 11);
    expect(control.y).toBeGreaterThanOrEqual(12);
    await page.screenshot({ path: path.join(outputDirectory, `${viewport.name}-restored-lifted.png`), fullPage: false });

    await choose(page, 'auto-asc');
    await expect(page.locator('#lups-menu-button')).toBeFocused();
    await expect(page.locator('#lups-control')).toHaveAttribute('data-lups-obstructed', 'true');
    await expect.poll(async () => {
      const controlBox = await page.locator('#lups-control').boundingBox();
      const obstructionBox = await page.locator('#lups-test-obstruction').boundingBox();
      return controlBox.y + controlBox.height <= obstructionBox.y - 11;
    }).toBe(true);
    await page.locator('#lups-flip-direction').focus();
    await page.screenshot({ path: path.join(outputDirectory, `${viewport.name}-active-lifted.png`), fullPage: false });

    await page.locator('#lups-menu-button').click();
    const menu = await page.locator('#lups-menu-host').boundingBox();
    const trigger = await page.locator('.lups-trigger-row').boundingBox();
    expect(menu.y).toBeGreaterThanOrEqual(0);
    expect(trigger.y - (menu.y + menu.height)).toBeGreaterThanOrEqual(7);
    expect(trigger.y - (menu.y + menu.height)).toBeLessThanOrEqual(13);
    await expect(page.locator('#lups-menu [data-lups-value]')).toHaveCount(6);
    await page.screenshot({ path: path.join(outputDirectory, `${viewport.name}-menu-lifted.png`), fullPage: false });
    await page.keyboard.press('Escape');

    await page.locator('#lups-test-obstruction').evaluate((element) => {
      element.style.height = `${element.getBoundingClientRect().height + 24}px`;
    });
    await page.waitForTimeout(0);
    await page.evaluate(() => { window.__lupsObstructionMutations = 0; });
    await expect.poll(async () => {
      const controlBox = await page.locator('#lups-control').boundingBox();
      const obstructionBox = await page.locator('#lups-test-obstruction').boundingBox();
      return controlBox.y + controlBox.height <= obstructionBox.y - 11;
    }).toBe(true);

    await choose(page, 'restore');
    await expect(page.locator('#lups-control')).toHaveAttribute('data-lups-obstructed', 'true');
    await expect.poll(async () => {
      const controlBox = await page.locator('#lups-control').boundingBox();
      const obstructionBox = await page.locator('#lups-test-obstruction').boundingBox();
      return controlBox.y + controlBox.height <= obstructionBox.y - 11;
    }).toBe(true);
    await page.screenshot({ path: path.join(outputDirectory, `${viewport.name}-restored-resized-lifted.png`), fullPage: false });

    expect(await page.locator('#lups-test-obstruction').getAttribute('data-untouched')).toBe('true');
    expect(await page.evaluate(() => window.__lupsObstructionMutations)).toBe(0);
    await page.locator('#lups-test-obstruction').evaluate((element) => element.remove());
    await expect(page.locator('#lups-control')).toHaveAttribute('data-lups-obstructed', 'false');
    await expect.poll(async () => {
      const box = await page.locator('#lups-control').boundingBox();
      return Math.abs(viewport.height - (box.y + box.height) - viewport.baselineBottom) <= 1;
    }).toBe(true);
    const returned = await page.locator('#lups-control').boundingBox();
    expect(Math.abs(viewport.height - (returned.y + returned.height) - viewport.baselineBottom)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: path.join(outputDirectory, `${viewport.name}-returned.png`), fullPage: false });
  }
});

test('does not move for ordinary, narrow, or fullscreen page layers', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await openFixture(page);
  await install(page);
  for (const style of [
    'position:static;height:90px',
    'position:fixed;right:0;bottom:0;width:180px;height:90px;z-index:2147483647',
    'position:fixed;inset:0;z-index:2147483647'
  ]) {
    await page.evaluate((cssText) => {
      const layer = document.createElement('div');
      layer.id = 'lups-test-non-obstruction';
      layer.style.cssText = cssText;
      document.body.append(layer);
    }, style);
    await page.waitForTimeout(250);
    await expect(page.locator('#lups-control')).toHaveAttribute('data-lups-obstructed', 'false');
    await page.locator('#lups-test-non-obstruction').evaluate((element) => element.remove());
  }
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    window.__lupsRootMutations = 0;
    new MutationObserver((records) => { window.__lupsRootMutations += records.length; })
      .observe(document.getElementById('lups-control'), {
        attributes: true,
        attributeFilter: ['style', 'data-lups-obstructed']
      });
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 40; index += 1) fragment.append(document.createElement('span'));
    document.body.append(fragment);
  });
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__lupsRootMutations)).toBe(0);
});

test('obstruction placement makes progress during continuous retailer DOM churn', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFixture(page);
  await install(page);
  await page.evaluate(() => {
    const churn = document.createElement('div');
    churn.id = 'lups-test-churn';
    document.body.append(churn);
    window.__lupsChurnInterval = setInterval(() => {
      churn.classList.toggle('retailer-churn');
      const child = document.createElement('span');
      churn.replaceChildren(child);
    }, 25);
    const obstruction = document.createElement('div');
    obstruction.id = 'lups-test-obstruction';
    obstruction.style.cssText = 'position:fixed;inset:auto 0 0 0;height:120px;background:#fff4d6;z-index:2147483000;pointer-events:auto';
    document.body.append(obstruction);
  });

  await expect(page.locator('#lups-control')).toHaveAttribute('data-lups-obstructed', 'true', { timeout: 1_500 });
  await page.locator('#lups-test-obstruction').evaluate((element) => element.remove());
  await expect(page.locator('#lups-control')).toHaveAttribute('data-lups-obstructed', 'false', { timeout: 1_500 });
  await page.evaluate(() => {
    clearInterval(window.__lupsChurnInterval);
    document.getElementById('lups-test-churn')?.remove();
    document.getElementById('lups-control')?.remove();
  });
});

test('captures the visual state matrix with computed UI evidence', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const evidence = await captureControlStateMatrix(page, {
    outputDirectory: path.join(root, 'artifacts/screenshots/control-state-matrix'),
    setup: async () => {
      await openVisualFixture(page);
      await install(page);
    },
    enterPending: () => page.evaluate(() => {
      document.querySelector('#grid').insertAdjacentHTML('beforeend', `
        <article class="market-card" data-fixture-id="visual-pending-sponsored"><h3 data-testid="product-title">Pending sponsored tile</h3>
        <span>Sponsored</span><a href="/product/visual-pending-sponsored?source=sptd">Sponsored result</a></article>`);
      history.pushState({}, '', `${location.pathname}?search-bar=milk&storeId=visual-pending`);
    }),
    exitPending: () => page.evaluate(() => {
      document.querySelector('[data-fixture-id="visual-pending-sponsored"]')?.remove();
      history.pushState({}, '', `${location.pathname}?search-bar=milk`);
    }),
    enterNoMatch: () => page.evaluate(() => {
      document.querySelector('#grid').insertAdjacentHTML('beforeend', `
        <article class="market-card" data-fixture-id="visual-no-match-sponsored"><h3 data-testid="product-title">No-match sponsored tile</h3>
        <span>Sponsored</span><a href="/product/visual-no-match-sponsored?source=sptc">Sponsored result</a></article>`);
      window.postMessage({
        source: 'rcss-price-per-unit', version: 2, type: 'api-products', mode: 'snapshot', revision: 2,
        context: { query: 'milk', pagePath: `${location.pathname}?search-bar=milk` },
        products: [{ id: 'other', name: 'Other', packageSizing: '1 kg', currentPrice: 3, regularPrice: 3 }]
      }, location.origin);
    }),
    exitNoMatch: () => page.evaluate((products) => {
      document.querySelector('[data-fixture-id="visual-no-match-sponsored"]')?.remove();
      window.postMessage({
        source: 'rcss-price-per-unit', version: 2, type: 'api-products', mode: 'snapshot', revision: 3,
        context: { query: 'milk', pagePath: `${location.pathname}?search-bar=milk` }, products
      }, location.origin);
    }, Object.values(INITIAL_API_PRODUCTS)),
    enterFilteredRestore: () => page.evaluate(() => document.querySelector('#grid').insertAdjacentHTML('beforeend', `
      <article class="market-card" data-fixture-id="visual-sponsored">
        <h3 data-testid="product-title">Sponsored visual tile</h3><span>Sponsored</span>
        <a href="/product/visual-sponsored?source=sptd">Sponsored result</a>
      </article>`)),
    exitFilteredRestore: () => page.locator('[data-fixture-id="visual-sponsored"]').evaluate((card) => card.remove())
  });
  expectControlStateMatrix(evidence);
  await captureForcedColorsControl(page, {
    outputDirectory: path.join(root, 'artifacts/screenshots/control-state-matrix'),
    setup: async () => {
      await openVisualFixture(page);
      await install(page);
    }
  });
  expect(pageErrors).toEqual([]);
});

test('mounts independently from a retailer toolbar', async ({ page }) => {
  await openFixture(page);
  const toolbarHtml = await page.locator('#toolbar').evaluate((toolbar) => toolbar.outerHTML);
  await page.locator('#toolbar').evaluate((toolbar) => toolbar.remove());
  await install(page);
  await expect(page.locator('#lups-control')).toHaveCount(1);
  await expect(page.locator('#lups-menu-button')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#lups-control').getByRole('status')).toHaveCount(1);
  await expect(page.locator('#lups-menu-host')).toBeHidden();
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
  const retailerAnnotation = page.locator('[data-fixture-id="volume-explicit"] [data-lups-annotation]');
  await expect(retailerAnnotation).toHaveText('$1.60/L · Retailer');
  await expect(retailerAnnotation).toHaveAttribute('aria-label', '$1.60 per litre, unit price supplied by the retailer API');
});

test('sorts every card returned by the scoped RCSS search API', async ({ page }) => {
  await openFixture(page, '?search-bar=milk');
  await install(page, INITIAL_TILES, 'milk');
  await choose(page, 'volume-asc');
  await expect(page.locator('#lups-status')).toContainText('8 loaded products');
  await expect(page.locator('[data-fixture-id="volume-explicit"] [data-lups-annotation]')).toHaveCount(1);
  await expect(page.locator('[data-fixture-id="mass-explicit"] [data-lups-annotation]')).toHaveCount(1);
  await expect(page.locator('[data-fixture-id="unknown"]')).toHaveCSS('order', '7');
});

test('clears same-query prices across a store transition until the new store snapshot arrives', async ({ page }) => {
  await openFixture(page, '?search-bar=milk&storeId=fixture-store');
  await install(page, INITIAL_TILES, 'milk');
  await choose(page, 'auto-asc');
  const annotation = page.locator('[data-fixture-id="volume-explicit"] [data-lups-annotation]');
  await expect(annotation).toHaveText('$1.60/L · Retailer');
  await page.locator('#grid').evaluate((grid) => grid.insertAdjacentHTML('beforeend', `
    <div data-fixture-id="pending-sponsored"><h3 data-testid="product-title">Pending sponsored</h3>
    <span>Sponsored</span><a href="/product/pending-sponsored?source=sptd">Sponsored result</a></div>`));
  await expect(page.locator('[data-fixture-id="pending-sponsored"]')).toHaveCSS('display', 'none');

  await page.evaluate(() => {
    history.pushState({}, '', '/test-fixture?search-bar=milk&storeId=second-store');
  });
  await expect(page.locator('[data-lups-annotation]')).toHaveCount(0);
  await expect(page.locator('[data-fixture-id="volume-explicit"]')).toHaveAttribute('data-lups-data-source', 'missing-api');
  await expect(page.locator('#lups-status')).toHaveText('Waiting for current-page product data · Website order preserved · 8 loaded products · 1 sponsored/ad tile hidden');
  await expect(page.locator('#lups-live-status')).toHaveText('Waiting for current-page product data · Website order preserved · 8 loaded products · 1 sponsored/ad tile hidden');
  await expect(page.locator('#lups-control').getByRole('status')).toHaveCount(1);

  await page.locator('#grid').evaluate((grid) => {
    window.__detachedLoblawGrid = grid;
    grid.remove();
  });
  await expect(page.locator('#lups-status')).toHaveText('Waiting for current-page product data · Website order preserved');
  await expect(page.locator('#lups-live-status')).toHaveText('Waiting for current-page product data · Website order preserved');
  expect(await page.evaluate(() => window.__detachedLoblawGrid
    .querySelector('[data-fixture-id="pending-sponsored"]').style.display)).not.toBe('none');
  await page.evaluate(() => document.body.append(window.__detachedLoblawGrid));
  await expect(page.locator('#lups-status')).toHaveText('Waiting for current-page product data · Website order preserved · 8 loaded products · 1 sponsored/ad tile hidden');
  await expect(page.locator('[data-fixture-id="pending-sponsored"]')).toHaveCSS('display', 'none');

  await fs.mkdir(path.join(root, 'artifacts/screenshots/truth-state'), { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(root, 'artifacts/screenshots/truth-state/loblaw-pending-phone.png'), fullPage: false });

  await page.route('https://api.pcexpress.ca/pcx-bff/api/v2/products/search', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(responseFor([tile('milk', 'Milk', '4 L, $0.18/100ml', 7.2)], 'milk'))
  }));
  await page.evaluate(() => fetch('https://api.pcexpress.ca/pcx-bff/api/v2/products/search', {
    method: 'POST',
    body: JSON.stringify({ listingInfo: { filters: { 'search-bar': ['milk'] } } })
  }));
  await expect(annotation).toHaveText('$1.80/L · Retailer');
  await expect(page.locator('[data-fixture-id="volume-explicit"]')).toHaveAttribute('data-lups-data-source', 'api');
  await expect(page.locator('#lups-status')).not.toContainText('Website order preserved');
});

test('Loblaw annotates a cached lazy card during continuous retailer DOM churn', async ({ page }) => {
  await openFixture(page, '?search-bar=milk');
  await install(page, INITIAL_TILES, 'milk');
  await expect(page.locator('[data-fixture-id="volume-explicit"] [data-lups-annotation]')).toHaveText('$1.60/L · Retailer');
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    document.querySelector('[data-fixture-id="volume-explicit"]').remove();
    const churn = document.createElement('div');
    churn.id = 'loblaw-retailer-churn';
    document.body.append(churn);
    window.__loblawChurnStopped = false;
    window.__loblawChurnInterval = setInterval(() => {
      churn.replaceChildren(document.createTextNode(String(Date.now())));
    }, 25);
    document.querySelector('#grid').insertAdjacentHTML('beforeend', `
      <div data-fixture-id="volume-lazy"><div data-testid="price-product-tile"><span data-testid="regular-price">$6.44</span></div>
      <h3 data-testid="product-title">Milk</h3><p data-testid="product-package-size">4 L</p><a href="/product/milk">Milk link</a></div>`);
    window.__loblawChurnStopTimer = setTimeout(() => {
      clearInterval(window.__loblawChurnInterval);
      window.__loblawChurnStopped = true;
    }, 2_000);
  });
  await expect(page.locator('[data-fixture-id="volume-lazy"] [data-lups-annotation]'))
    .toHaveText('$1.60/L · Retailer', { timeout: 1_200 });
  expect(await page.evaluate(() => window.__loblawChurnStopped)).toBe(false);
  await page.evaluate(() => {
    clearInterval(window.__loblawChurnInterval);
    clearTimeout(window.__loblawChurnStopTimer);
  });
});

test('Loblaw preserves website order for an accepted snapshot with no rendered product matches', async ({ page }) => {
  await openFixture(page, '?search-bar=milk');
  await install(page, INITIAL_TILES, 'milk');
  await choose(page, 'mass-asc');
  await page.locator('#grid').evaluate((grid) => grid.insertAdjacentHTML('beforeend', `
    <div data-fixture-id="no-match-sponsored"><h3 data-testid="product-title">No-match sponsored</h3>
    <span>Sponsored</span><a href="/product/no-match-sponsored?source=sptc">Sponsored result</a></div>`));
  await expect(page.locator('[data-fixture-id="no-match-sponsored"]')).toHaveCSS('display', 'none');
  await page.evaluate(() => window.postMessage({
    source: 'rcss-price-per-unit', version: 2, type: 'api-products', mode: 'snapshot', revision: 2,
    context: { query: 'milk', pagePath: '/test-fixture?search-bar=milk' },
    products: [{ id: 'other', name: 'Other', packageSizing: '1 kg', currentPrice: 3, regularPrice: 3 }]
  }, location.origin));
  await expect(page.locator('#lups-status')).toHaveText('No matching product data in these loaded results · Website order preserved · 8 loaded products · 1 sponsored/ad tile hidden');
  await expect(page.locator('#lups-live-status')).toHaveText('No matching product data in these loaded results · Website order preserved · 8 loaded products · 1 sponsored/ad tile hidden');
  await expect(page.locator('[data-fixture-id="mass-explicit"]')).toHaveCSS('order', '0');
});

test('Loblaw never ranks zero-price API sentinels as free products', async ({ page }) => {
  await openFixture(page, '?search-bar=milk');
  await install(page, INITIAL_TILES, 'milk');
  await page.evaluate(() => window.postMessage({
    source: 'rcss-price-per-unit', version: 2, type: 'api-products', mode: 'snapshot', revision: 2,
    context: { query: 'milk', pagePath: '/test-fixture?search-bar=milk' },
    products: [
      { id: 'flour', name: 'Zero sentinel', packageSizing: '1 kg', currentPrice: 0, regularPrice: 0 },
      { id: 'milk', name: 'Negative zero sentinel', packageSizing: '4 L', currentPrice: -0, regularPrice: -0 },
      { id: 'rice', name: 'Valid price', packageSizing: '2 kg', currentPrice: 4, regularPrice: 4 }
    ]
  }, location.origin));
  await choose(page, 'total-asc');

  const order = await page.locator('#grid > div').evaluateAll((cards) => cards
    .map((card) => ({ id: card.dataset.fixtureId, order: Number(getComputedStyle(card).order) }))
    .sort((left, right) => left.order - right.order).map((item) => item.id));
  expect(order.slice(0, 3)).toEqual(['mass-sale', 'mass-explicit', 'volume-explicit']);
  await expect(page.locator('[data-fixture-id="mass-explicit"]')).toHaveAttribute('data-lups-data-source', 'missing-api');
  await expect(page.locator('[data-fixture-id="volume-explicit"]')).toHaveAttribute('data-lups-data-source', 'missing-api');
  await expect(page.locator('#lups-status')).toContainText('1 priced');
});

test('Loblaw bounds bridge arrays before reads and preserves the newer reentrant snapshot', async ({ page }) => {
  await openFixture(page, '?search-bar=milk');
  await install(page, INITIAL_TILES, 'milk');
  const annotation = page.locator('[data-fixture-id="volume-explicit"] [data-lups-annotation]');
  await expect(annotation).toHaveText('$1.60/L · Retailer');
  await choose(page, 'auto-asc');

  const oversizedReads = await page.evaluate(() => {
    let reads = 0;
    const oversized = new Proxy([], {
      get(target, property, receiver) {
        if (property === 'length') return 501;
        if (/^\d+$/.test(String(property))) reads += 1;
        return Reflect.get(target, property, receiver);
      }
    });
    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: location.origin,
      data: {
        source: 'rcss-price-per-unit', version: 2, type: 'api-products', mode: 'snapshot', revision: 2,
        context: { query: 'milk', pagePath: '/test-fixture?search-bar=milk' },
        products: oversized
      }
    }));
    return reads;
  });
  expect(oversizedReads).toBe(0);
  await expect(annotation).toHaveText('$1.60/L · Retailer');

  const alternatingReads = await page.evaluate(() => {
    let lengthReads = 0;
    let indexReads = 0;
    const products = new Proxy([
      { id: 'milk', name: 'Bounded update', packageSizing: '4 L', currentPrice: 6.4, regularPrice: 6.4 }
    ], {
      get(target, property, receiver) {
        if (property === 'length') {
          lengthReads += 1;
          return lengthReads === 1 ? 1 : 1_000_000_000;
        }
        if (/^\d+$/.test(String(property))) indexReads += 1;
        return Reflect.get(target, property, receiver);
      }
    });
    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: location.origin,
      data: {
        source: 'rcss-price-per-unit', version: 2, type: 'api-products', mode: 'snapshot', revision: 2,
        context: { query: 'milk', pagePath: '/test-fixture?search-bar=milk' },
        products
      }
    }));
    return { lengthReads, indexReads };
  });
  expect(alternatingReads).toEqual({ lengthReads: 1, indexReads: 1 });
  await expect(annotation).toHaveText('$1.60/L · Calculated');

  await page.evaluate(() => window.postMessage({
    source: 'rcss-price-per-unit', version: 2, type: 'api-products', mode: 'snapshot', revision: 3,
    context: { query: 'milk', pagePath: '/test-fixture?search-bar=milk' },
    products: [
      { id: 'milk', name: 'Duplicate one', packageSizing: '4 L', currentPrice: 8, regularPrice: 8 },
      { id: 'milk', name: 'Duplicate two', packageSizing: '4 L', currentPrice: 12, regularPrice: 12 }
    ]
  }, location.origin));
  await page.waitForTimeout(0);
  await expect(annotation).toHaveText('$1.60/L · Calculated');

  await page.evaluate(() => {
    const outerProducts = [];
    Object.defineProperty(outerProducts, '0', {
      get() {
        window.dispatchEvent(new MessageEvent('message', {
          source: window,
          origin: location.origin,
          data: {
            source: 'rcss-price-per-unit', version: 2, type: 'api-products', mode: 'snapshot', revision: 4,
            context: { query: 'milk', pagePath: '/test-fixture?search-bar=milk' },
            products: [{ id: 'other', name: 'Newer snapshot', packageSizing: '1 kg', currentPrice: 3, regularPrice: 3 }]
          }
        }));
        return { id: 'milk', name: 'Older reentrant update', packageSizing: '4 L', currentPrice: 40, regularPrice: 40 };
      }
    });
    outerProducts.length = 1;
    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: location.origin,
      data: {
        source: 'rcss-price-per-unit', version: 2, type: 'api-products', mode: 'snapshot', revision: 3,
        context: { query: 'milk', pagePath: '/test-fixture?search-bar=milk' },
        products: outerProducts
      }
    }));
  });
  await expect(page.locator('#lups-status')).toHaveText('No matching product data in these loaded results · Website order preserved · 8 loaded products');
  await expect(annotation).toHaveCount(0);
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
  await expect(annotation).toContainText('$6.00/kg');
  await page.locator('[data-fixture-id="mass-explicit"] [data-testid="product-package-size"]').evaluate((node) => {
    node.firstChild.data = '1 kg, $0.40/100g';
  });
  await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
  await expect(annotation).toContainText('$6.00/kg');
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

test('resumes scanning after a persisted Safari page lifecycle', async ({ page }) => {
  await openFixture(page);
  await install(page);
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    document.getElementById('lups-control').remove();
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect(page.locator('#lups-control')).toHaveCount(1);
  await expect(page.locator('#lups-menu-button')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#lups-menu-host')).toBeHidden();
  await expect(page.locator('#lups-control').getByRole('status')).toHaveCount(1);
});

test('keeps the control styled when a retailer CSP rejects inline styles', async ({ page }) => {
  await page.route('https://www.realcanadiansuperstore.ca/csp-fixture*', (route) => route.fulfill({
    body: fixtureHtml,
    contentType: 'text/html',
    headers: { 'Content-Security-Policy': "style-src 'none'" }
  }));
  await page.goto('https://www.realcanadiansuperstore.ca/csp-fixture?search-bar=milk');
  await install(page, INITIAL_TILES, 'milk');

  // Safari reports a CSP violation for the fallback <style>, but the CSSOM
  // stylesheet must still keep the userscript usable and visually isolated.
  await expect(page.locator('#lups-control')).toHaveCSS('position', 'fixed');
  await expect(page.locator('#lups-menu-button')).toHaveCSS('display', 'grid');
  await expect(page.locator('#lups-menu-button')).toHaveCSS('border-radius', '999px');
  await expect(page.locator('[data-lups-annotation]').first()).toHaveCSS('border-radius', '999px');

  // A retailer SPA may rebuild <head> and replace the document stylesheet list.
  // The next ordinary scan must repair both attachment paths without duplicating
  // the control or requiring a reload.
  await page.evaluate(() => {
    document.getElementById('lups-styles')?.remove();
    document.adoptedStyleSheets = [];
    document.querySelector('main').append(document.createElement('i'));
  });
  await expect(page.locator('#lups-control')).toHaveCSS('position', 'fixed');
  await expect(page.locator('#lups-menu-button')).toHaveCSS('border-radius', '999px');
  await expect(page.locator('#lups-control')).toHaveCount(1);
});

test('disables panel animation when reduced motion is requested', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openFixture(page);
  await install(page);
  for (const selector of ['#lups-control', '#lups-menu-button', '#lups-flip-direction', '.lups-option-icon']) {
    await expect(page.locator(selector).first()).toHaveCSS('transition-duration', '0s');
  }
});
