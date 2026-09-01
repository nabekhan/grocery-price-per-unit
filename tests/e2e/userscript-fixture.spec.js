import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { captureControlStateMatrix, captureForcedColorsControl, expectControlStateMatrix } from './control-state-matrix.js';

const root = process.cwd();
const fixture = await fs.readFile(path.join(root, 'tests/fixtures/product-grid.html'), 'utf8');
const visualFixture = await fs.readFile(path.join(root, 'tests/fixtures/visual-marketplace-shell.html'), 'utf8');
const userscript = await fs.readFile(
  path.join(root, 'dist/userscript/Grocery Price Per Unit.user.js'),
  'utf8'
);
const products = [
  { productId: 'flour', title: 'Flour', packageSizing: '1 kg, $0.60/100g', pricing: { price: '5.96' } },
  { productId: 'milk', title: 'Milk', packageSizing: '4 L, $0.16/100ml', pricing: { price: '6.44' } },
  { productId: 'rice', title: 'Rice sale', packageSizing: '2 kg', pricing: { price: '4.00' } },
  { productId: 'chicken', title: 'Chicken', packageSizing: 'approximately 800 g, $10.88/1lb', pricing: { price: '12.00' } },
  { productId: 'eggs', title: 'Eggs', packageSizing: '12 count', pricing: { price: '6.00' } },
  { productId: 'cans', title: 'Cans', packageSizing: '6 x 355 mL', pricing: { price: '12.00' } },
  { productId: 'conditional', title: 'Conditional', packageSizing: '1 ea', pricing: { price: null } },
  { productId: 'mystery', title: 'Mystery', packageSizing: 'family size', pricing: { price: '8.00' } }
];
const apiProducts = products.map((product) => ({
  id: product.productId,
  name: product.title,
  packageSizing: product.packageSizing,
  currentPrice: product.pricing.price === null ? null : Number(product.pricing.price),
  regularPrice: null,
  displayPrice: null,
  weighted: null
}));
const nextData = JSON.stringify({
  props: {
    pageProps: {
      initialSearchData: {
        searchTermSubmitted: 'milk',
        layout: {
          sections: {
            mainContentCollection: {
              components: [{ data: { productTiles: products } }]
            }
          }
        }
      }
    }
  }
}).replaceAll('<', '\\u003c');
const fixtureWithData = fixture.replace(
  '</body>',
  `<script id="__NEXT_DATA__" type="application/json">${nextData}</script></body>`
);
const visualFixtureWithData = visualFixture.replace(
  '</body>',
  `<script id="__NEXT_DATA__" type="application/json">${nextData}</script></body>`
);

test('single page-world userscript captures and sorts without GM privileges', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript({ content: userscript });
  await page.route('https://www.realcanadiansuperstore.ca/test-fixture*', (route) => route.fulfill({
    body: fixtureWithData,
    contentType: 'text/html'
  }));
  await page.goto('https://www.realcanadiansuperstore.ca/test-fixture?search-bar=milk');

  await expect(page.locator('#lups-control')).toHaveCount(1);
  await expect(page.locator('[data-fixture-id="volume-explicit"]')).toHaveAttribute('data-lups-data-source', 'api');
  await expect(page.locator('[data-fixture-id="volume-explicit"] [data-lups-annotation]')).toHaveText('$1.60/L · Retailer');

  await expect(page.locator('#lups-auto-sort')).toHaveAttribute('aria-label', 'Sort automatically, low to high');
  await page.locator('#lups-auto-sort').click();
  await expect(page.locator('#lups-auto-sort')).toBeHidden();
  await expect(page.locator('#lups-status')).toContainText('3 comparable');
  await expect(page.locator('#lups-status')).not.toContainText('Automatic chose');
  await expect(page.locator('#lups-live-status')).toContainText('Automatic chose $/kg · Low → high · 3 comparable');
  await expect(page.locator('#lups-status')).toContainText('2 unavailable');
  await expect(page.locator('#lups-status')).toBeVisible();
  await expect(page.locator('#lups-restore')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore website order' })).toBeVisible();
  await expect(page.locator('#lups-menu-button-text')).toHaveText('Auto · $/kg · Low → high');
  await expect.poll(() => page.evaluate(() => localStorage.getItem(
    '__gppu_userscript_storage__:sync:defaultSortMode'
  ))).toBe('"auto-asc"');
  await page.locator('#lups-flip-direction').click();
  await expect(page.locator('#lups-mode')).toHaveValue('auto-desc');
  await expect(page.locator('#lups-menu-button')).toBeFocused();
  await expect(page.locator('#lups-menu-button')).toHaveAccessibleName('Unit price Auto · $/kg · High → low');
  await expect.poll(() => page.evaluate(() => localStorage.getItem(
    '__gppu_userscript_storage__:sync:defaultSortMode'
  ))).toBe('"auto-desc"');
  await expect(page.locator('.lups-menu-group')).toHaveCount(4);
  await page.keyboard.press('Enter');
  await expect(page.locator('#lups-menu-button')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('menuitemradio', { name: 'Automatic, Predominant comparable unit' })).toBeFocused();
  await expect(page.getByRole('menuitemradio', { name: 'Automatic, Predominant comparable unit' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#lups-mode')).toHaveValue('auto-desc');
  await expect(page.locator('[role="menuitemradio"][aria-checked="true"]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('#lups-menu-button')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#lups-restore').click();
  await expect(page.locator('#lups-live-status')).toContainText('Website order · 8 loaded products');
  await expect(page.locator('#lups-status-row')).toBeHidden();
  await expect(page.locator('#lups-restore')).toBeHidden();
  await expect(page.locator('#lups-auto-sort')).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem(
    '__gppu_userscript_storage__:sync:defaultSortMode'
  ))).toBe('"restore"');
  await page.locator('#lups-menu-button').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#lups-menu-button')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('menuitemradio', { name: 'Website order, Keep the retailer’s current order' })).toBeFocused();
  await expect(page.locator('[role="menuitemradio"][aria-checked="true"]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('#lups-menu-button')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#lups-menu-button')).toBeFocused();
  expect(pageErrors).toEqual([]);
});

test('captures the visual state matrix from the built userscript artifact', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript({ content: userscript });
  await page.route('https://www.realcanadiansuperstore.ca/visual-userscript-fixture*', (route) => route.fulfill({
    body: visualFixtureWithData,
    contentType: 'text/html'
  }));
  const evidence = await captureControlStateMatrix(page, {
    outputDirectory: path.join(root, 'artifacts/screenshots/userscript-control-state-matrix'),
    setup: () => page.goto('https://www.realcanadiansuperstore.ca/visual-userscript-fixture?search-bar=milk'),
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
    }, apiProducts),
    enterFilteredRestore: () => page.evaluate(() => document.querySelector('#grid').insertAdjacentHTML('beforeend', `
      <article class="market-card" data-fixture-id="visual-sponsored">
        <h3 data-testid="product-title">Sponsored visual tile</h3><span>Sponsored</span>
        <a href="/product/visual-sponsored?source=sptd">Sponsored result</a>
      </article>`)),
    exitFilteredRestore: () => page.locator('[data-fixture-id="visual-sponsored"]').evaluate((card) => card.remove())
  });
  expectControlStateMatrix(evidence);
  await captureForcedColorsControl(page, {
    outputDirectory: path.join(root, 'artifacts/screenshots/userscript-control-state-matrix'),
    setup: () => page.goto('https://www.realcanadiansuperstore.ca/visual-userscript-fixture?search-bar=milk')
  });
  expect(pageErrors).toEqual([]);
});

test('built userscript lifts above a broad bottom obstruction and returns', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript({ content: userscript });
  await page.route('https://www.realcanadiansuperstore.ca/obstruction-userscript-fixture*', (route) => route.fulfill({
    body: fixtureWithData,
    contentType: 'text/html'
  }));
  await page.goto('https://www.realcanadiansuperstore.ca/obstruction-userscript-fixture?search-bar=milk');
  await page.locator('#lups-menu-button').click();
  await page.locator('[data-lups-value="auto-asc"]').click();
  await page.evaluate(() => {
    const obstruction = document.createElement('div');
    obstruction.id = 'userscript-obstruction';
    obstruction.style.cssText = 'position:fixed;inset:auto 0 0 0;height:120px;z-index:2147483000;background:white;pointer-events:auto';
    document.body.append(obstruction);
  });
  await expect(page.locator('#lups-control')).toHaveAttribute('data-lups-obstructed', 'true');
  await expect.poll(async () => {
    const control = await page.locator('#lups-control').boundingBox();
    const obstruction = await page.locator('#userscript-obstruction').boundingBox();
    return control.y + control.height <= obstruction.y - 11;
  }).toBe(true);
  await page.locator('#userscript-obstruction').evaluate((element) => element.remove());
  await expect(page.locator('#lups-control')).toHaveAttribute('data-lups-obstructed', 'false');
  await expect.poll(async () => {
    const control = await page.locator('#lups-control').boundingBox();
    return Math.abs(844 - (control.y + control.height) - 14) <= 1;
  }).toBe(true);
});

test('No Frills userscript captures its shared Loblaw API model from document-start', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript({ content: userscript });
  await page.route('https://www.nofrills.ca/document-start-fixture*', (route) => route.fulfill({
    body: fixtureWithData,
    contentType: 'text/html'
  }));

  await page.goto('https://www.nofrills.ca/document-start-fixture?search-bar=milk');
  await expect(page.locator('#lups-control')).toHaveCount(1);
  await expect(page.locator('[data-fixture-id="volume-explicit"]')).toHaveAttribute('data-lups-data-source', 'api');
  await expect(page.locator('[data-fixture-id="volume-explicit"] [data-lups-annotation]')).toHaveText('$1.60/L · Retailer');
  await page.locator('#lups-menu-button').click();
  await page.locator('[data-lups-value="auto-asc"]').click();
  await expect(page.locator('#lups-status')).toContainText('3 comparable');
  await expect(page.locator('#lups-live-status')).toContainText('Automatic chose $/kg · Low → high · 3 comparable');
  await expect(page.locator('#lups-control')).toHaveCount(1);
  expect(pageErrors).toEqual([]);
});

test('built No Frills userscript hides and safely restores only an exact sponsored card', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript({ content: userscript });
  await page.route('https://www.nofrills.ca/sponsored-fixture*', (route) => route.fulfill({
    body: fixtureWithData,
    contentType: 'text/html'
  }));
  await page.goto('https://www.nofrills.ca/sponsored-fixture?search-bar=milk');

  await page.locator('#grid').evaluate((grid) => grid.insertAdjacentHTML('afterbegin', `
    <div data-fixture-id="userscript-sponsored" style="display:flex">
      <h3 data-testid="product-title">Userscript promotion</h3>
      <span>Sponsored</span>
      <a href="/product/userscript-sponsored?source=sptd">Sponsored product</a>
      <button>Inspect sponsored product</button>
    </div>
    <div data-fixture-id="userscript-false-positive">
      <h3 data-testid="product-title">Sponsored weekly picks</h3>
      <a href="/product/userscript-false-positive?source=sptd">Ordinary product</a>
    </div>
    <div data-fixture-id="userscript-link-text-sponsored">
      <h3 data-testid="product-title">Ordinary link label</h3>
      <a href="/product/userscript-link-text-sponsored?source=sptd">Sponsored</a>
    </div>
    <div data-fixture-id="userscript-exact-title-sponsored">
      <h3 data-testid="product-title">Sponsored</h3>
      <a href="/product/userscript-exact-title-sponsored?source=sptd">Ordinary title product</a>
    </div>
  `));

  const sponsored = page.locator('[data-fixture-id="userscript-sponsored"]');
  await expect(sponsored).toHaveCSS('display', 'none');
  await expect(page.locator('[data-fixture-id="userscript-false-positive"]')).toBeVisible();
  await expect(page.locator('[data-fixture-id="userscript-link-text-sponsored"]')).toBeVisible();
  await expect(page.locator('[data-fixture-id="userscript-exact-title-sponsored"]')).toBeVisible();
  await expect(page.locator('#lups-status')).toContainText('1 sponsored/ad tile hidden');
  await page.locator('#lups-auto-sort').click();
  await page.locator('#lups-restore').click();
  await expect(sponsored).toHaveCSS('display', 'none');
  await expect(sponsored.locator('button')).toHaveCount(1);
  expect(await sponsored.locator('button').evaluate((button) => !button.disabled)).toBe(true);

  await page.locator('#grid').evaluate((grid) => {
    const keep = grid.querySelector('[data-fixture-id="userscript-sponsored"]');
    grid.replaceChildren(keep);
  });
  await expect(sponsored).toHaveCSS('display', 'flex');
  await sponsored.locator('a').evaluate((link) => link.setAttribute('href', '/product/userscript-sponsored?source=organic'));
  await expect(sponsored).toHaveCSS('display', 'flex');
  expect(pageErrors).toEqual([]);
});

test('userscript still starts when Safari origin storage is unavailable', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    for (const method of ['getItem', 'setItem', 'removeItem', 'key']) {
      Object.defineProperty(Storage.prototype, method, {
        configurable: true,
        value() { throw new DOMException('Storage denied', 'SecurityError'); }
      });
    }
  });
  await page.route('https://www.walmart.ca/storage-fixture*', (route) => route.fulfill({
    body: `<!doctype html><style>.wrapper,.card{width:120px;height:60px}</style><div id="grid">
      <div class="wrapper"><div class="card" data-item-id="one" data-ppu-sort-dimension="mass" data-ppu-sort-value="1" data-ppu-total-price="2"></div></div>
      <div class="wrapper"><div class="card" data-item-id="two" data-ppu-sort-dimension="mass" data-ppu-sort-value="2" data-ppu-total-price="3"></div></div>
    </div>`,
    contentType: 'text/html'
  }));
  await page.goto('https://www.walmart.ca/storage-fixture?q=milk');
  await page.addScriptTag({ content: userscript });

  await expect(page.locator('#lups-control')).toHaveCount(1);
  await page.locator('#lups-menu-button').click();
  await page.locator('[data-lups-value="mass-asc"]').click();
  await expect(page.locator('#lups-status')).toHaveText('Waiting for current-page product data · Website order preserved · 2 loaded products');
  await expect(page.locator('#lups-live-status')).toHaveText('Waiting for current-page product data · Website order preserved · 2 loaded products');
  await expect(page.locator('#lups-control')).toHaveAttribute('data-lups-data-state', 'pending');
  expect(pageErrors).toEqual([]);
});

test('userscript keeps the newer in-memory preference after a partial storage failure', async ({ page }) => {
  await page.route('https://www.realcanadiansuperstore.ca/partial-storage*', (route) => route.fulfill({
    body: fixtureWithData,
    contentType: 'text/html'
  }));
  await page.goto('https://www.realcanadiansuperstore.ca/partial-storage?search-bar=milk');
  await page.evaluate(() => localStorage.setItem('__gppu_userscript_storage__:sync:defaultSortMode', '"restore"'));
  await page.addScriptTag({ content: userscript });
  await page.evaluate(() => Object.defineProperty(Storage.prototype, 'setItem', {
    configurable: true,
    value() { throw new DOMException('Quota exceeded', 'QuotaExceededError'); }
  }));

  await page.locator('#lups-menu-button').click();
  await page.locator('[data-lups-value="mass-asc"]').click();
  await expect.poll(() => page.evaluate(async () => {
    const capability = globalThis[Symbol.for('grocery-price-per-unit.storage.v1')];
    return (await capability.storage.sync.get({ defaultSortMode: 'restore' })).defaultSortMode;
  })).toBe('mass-asc');
  await expect.poll(() => page.evaluate(() => localStorage.getItem(
    '__gppu_userscript_storage__:sync:defaultSortMode'
  ))).toBe('"restore"');
});

test('Walmart userscript starts its sorter without an extension runtime', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('https://www.walmart.ca/test-fixture*', (route) => route.fulfill({
    body: `<!doctype html><html><head><style>
      #grid{display:flex;flex-wrap:wrap}.wrapper{width:140px;height:80px}.card{width:130px;height:70px}
    </style></head><body>
      <div id="grid">
        <div class="wrapper"><div class="card" data-item-id="m2" data-ppu-sort-dimension="mass" data-ppu-sort-value="2" data-ppu-total-price="4"></div></div>
        <div class="wrapper"><div class="card" data-item-id="m1" data-ppu-sort-dimension="mass" data-ppu-sort-value="1" data-ppu-total-price="6"></div></div>
        <div data-testid="tile-take-over" data-name="takeover-ad">Promotional tile</div>
        <div id="search-MarqueeDisplayAd-fixture-ad-wrapper" data-name="display-ad">Display ad</div>
        <div data-name="ordinary-content">Ordinary non-product content</div>
      </div>
    </body></html>`,
    contentType: 'text/html'
  }));
  await page.goto('https://www.walmart.ca/test-fixture?q=milk');
  await page.addScriptTag({ content: userscript });

  await expect(page.locator('#lups-control')).toHaveCount(1);
  await expect(page.locator('[data-name="takeover-ad"]')).toHaveCSS('display', 'none');
  await expect(page.locator('[data-name="display-ad"]')).toHaveCSS('display', 'none');
  await expect(page.locator('[data-name="ordinary-content"]')).not.toHaveCSS('display', 'none');
  await page.locator('#lups-menu-button').click();
  await expect(page.locator('#lups-menu')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('Walmart userscript starts at document-start and carries captured API data into sorting', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript({ content: userscript });
  await page.route('https://www.walmart.ca/orchestra/snb/graphql/search*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      data: {
        search: {
          itemStacks: [{
            itemsV2: [
              { id: 'mass-two', name: 'Rice 2 kg', priceInfo: { currentPrice: { price: 4 }, unitPrice: { priceString: '$0.50/100g' } } },
              { id: 'mass-one', name: 'Flour 1 kg', priceInfo: { currentPrice: { price: 1 } } }
            ]
          }]
        }
      }
    })
  }));
  await page.route('https://www.walmart.ca/document-start-fixture*', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head><style>
      #grid{display:flex}.wrapper,.card{width:140px;height:90px}
    </style></head><body><div id="grid">
      <div class="wrapper"><div class="card" data-item-id="mass-two"><span data-automation-id="product-price">$4.00</span></div></div>
      <div class="wrapper"><div class="card" data-item-id="mass-one"><span data-automation-id="product-price">$1.00</span></div></div>
    </div><script>
      fetch('/orchestra/snb/graphql/search?variables=' + encodeURIComponent(JSON.stringify({query:'flour',page:1})));
    </script></body></html>`
  }));

  await page.goto('https://www.walmart.ca/document-start-fixture?q=flour');
  await expect(page.locator('#lups-control')).toHaveCount(1);
  await expect(page.locator('[data-item-id="mass-one"]')).toHaveAttribute('data-ppu-data-source', 'api');
  await expect(page.locator('[data-item-id="mass-one"] .price-per-unit-info')).toHaveText('$1.00/kg · Calculated');
  await expect(page.locator('[data-item-id="mass-one"] .price-per-unit-info')).toHaveAttribute('aria-label', '$1.00 per kilogram, calculated from retailer API package and price data');
  await expect(page.locator('[data-item-id="mass-two"] .price-per-unit-info')).toHaveText('$5.00/kg · Retailer');
  await expect(page.locator('[data-item-id="mass-two"] .price-per-unit-info')).toHaveAttribute('aria-label', '$5.00 per kilogram, unit price supplied by the retailer API');
  await page.locator('#lups-menu-button').click();
  await page.locator('[data-lups-value="mass-asc"]').click();
  await expect(page.locator('#lups-status')).toContainText('2 comparable');
  await expect(page.locator('#lups-live-status')).toContainText('Sorted by $/kg · Low → high · 2 comparable');
  const orderedIds = await page.locator('#grid > .wrapper').evaluateAll((wrappers) => wrappers
    .map((wrapper) => ({ id: wrapper.querySelector('[data-item-id]')?.dataset.itemId, order: Number(wrapper.style.order) }))
    .sort((left, right) => left.order - right.order)
    .map(({ id }) => id));
  expect(orderedIds).toEqual(['mass-one', 'mass-two']);
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-item-id]')];
    const forgedModels = new WeakMap();
    forgedModels.set(cards[0], Object.freeze({ matched: true, normalizedUnitPrice: 0.000001, currentPrice: 1, dimension: 'mass' }));
    forgedModels.set(cards[1], Object.freeze({ matched: true, normalizedUnitPrice: 999999, currentPrice: 1, dimension: 'mass' }));
    Object.defineProperty(globalThis, Symbol.for('grocery-price-per-unit.walmart.api-scan.v1'), {
      configurable: false,
      writable: false,
      value: Object.freeze({ accepted: true, renderedCards: 2, apiCards: 2, models: forgedModels })
    });
    cards[0].dataset.ppuSortValue = '0.000001';
    cards[1].dataset.ppuSortValue = '999999';
    for (let index = 0; index < 10_000; index += 1) window.dispatchEvent(new CustomEvent('ppu-products-updated'));
  });
  await page.waitForTimeout(350);
  const orderAfterForgery = await page.locator('#grid > .wrapper').evaluateAll((wrappers) => wrappers
    .map((wrapper) => ({ id: wrapper.querySelector('[data-item-id]')?.dataset.itemId, order: Number(wrapper.style.order) }))
    .sort((left, right) => left.order - right.order)
    .map(({ id }) => id));
  expect(orderAfterForgery).toEqual(['mass-one', 'mass-two']);
  await page.evaluate(() => {
    const expensiveCard = document.querySelector('[data-item-id="mass-two"]');
    window.__gppuNativeWeakMapGet = WeakMap.prototype.get;
    window.__gppuNativeMapGet = Map.prototype.get;
    WeakMap.prototype.get = function poisonedWeakMapGet(key) {
      const value = Reflect.apply(window.__gppuNativeWeakMapGet, this, [key]);
      if (key === expensiveCard && value && typeof value === 'object' &&
          'matched' in value && 'normalizedUnitPrice' in value && 'dimension' in value) {
        return Object.freeze({ ...value, normalizedUnitPrice: 0.000001 });
      }
      return value;
    };
    Map.prototype.get = function poisonedMapGet(key) {
      const value = Reflect.apply(window.__gppuNativeMapGet, this, [key]);
      if (key === 'mass-one' && value?.id === 'mass-one') return { ...value, price: 999999 };
      return value;
    };
    document.querySelector('[data-item-id="mass-one"]').classList.toggle('retailer-update');
    for (let index = 0; index < 10_000; index += 1) {
      window.dispatchEvent(new CustomEvent('ppu-products-updated'));
    }
  });
  await page.waitForTimeout(400);
  const orderAfterPrototypePoisoning = await page.locator('#grid > .wrapper').evaluateAll((wrappers) => wrappers
    .map((wrapper) => ({ id: wrapper.querySelector('[data-item-id]')?.dataset.itemId, order: Number(wrapper.style.order) }))
    .sort((left, right) => left.order - right.order)
    .map(({ id }) => id));
  expect(orderAfterPrototypePoisoning).toEqual(['mass-one', 'mass-two']);
  await page.evaluate(() => {
    WeakMap.prototype.get = window.__gppuNativeWeakMapGet;
    Map.prototype.get = window.__gppuNativeMapGet;
  });
  await page.locator('#grid').evaluate((grid) => {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 499; index += 1) {
      const wrapper = document.createElement('div');
      wrapper.className = 'wrapper';
      wrapper.innerHTML = '<div class="card" data-item-id="mass-one"><span data-automation-id="product-price">$1.00</span></div>';
      fragment.append(wrapper);
    }
    grid.append(fragment);
  });
  await expect(page.locator('#lups-control')).toHaveAttribute('data-lups-data-state', 'pending');
  await expect(page.locator('#lups-status')).toContainText('Waiting for current-page product data');
  await expect(page.locator('[data-item-id="mass-two"]').locator('..')).toHaveCSS('order', '0');
  await expect(page.locator('#lups-control')).toHaveCount(1);
  expect(pageErrors).toEqual([]);
});

test('Walmart never ranks zero API prices and removes stale zero-derived annotations', async ({ page }) => {
  const pageErrors = [];
  let responses = 0;
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript({ content: userscript });
  await page.route('https://www.walmart.ca/orchestra/snb/graphql/search*', (route) => {
    responses += 1;
    const zeroUpdate = responses > 1;
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { search: { itemStacks: [{ itemsV2: [
        {
          id: 'zero-calculated', name: 'Rice 1 kg',
          priceInfo: { currentPrice: { price: zeroUpdate ? -0 : 4 } }
        },
        {
          id: 'zero-explicit', name: 'Flour 1 kg',
          priceInfo: {
            currentPrice: { price: 5 },
            unitPrice: { priceString: zeroUpdate ? '$0.00/100g' : '$0.50/100g' }
          }
        }
      ] }] } } })
    });
  });
  await page.route('https://www.walmart.ca/zero-price-fixture*', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><style>#grid{display:flex}.wrapper,.card{width:140px;height:90px}</style>
      <div id="grid">
        <div class="wrapper"><div class="card" data-item-id="zero-calculated"><span data-automation-id="product-price">$4.00</span></div></div>
        <div class="wrapper"><div class="card" data-item-id="zero-explicit"><span data-automation-id="product-price">$5.00</span></div></div>
      </div><script>window.initialProducts = fetch('/orchestra/snb/graphql/search?variables=' + encodeURIComponent(JSON.stringify({query:'rice',page:1})));</script>`
  }));

  await page.goto('https://www.walmart.ca/zero-price-fixture?q=rice');
  await expect(page.locator('[data-item-id="zero-calculated"] [data-lups-annotation]')).toHaveText('$4.00/kg · Calculated');
  await expect(page.locator('[data-item-id="zero-explicit"] [data-lups-annotation]')).toHaveText('$5.00/kg · Retailer');

  await page.evaluate(() => fetch('/orchestra/snb/graphql/search?variables=' + encodeURIComponent(JSON.stringify({ query: 'rice', page: 1 }))));
  await expect(page.locator('[data-item-id="zero-calculated"] [data-lups-annotation]')).toHaveCount(0);
  await expect(page.locator('[data-item-id="zero-calculated"]')).not.toHaveAttribute('data-ppu-sort-value', /.+/);
  await expect(page.locator('[data-item-id="zero-explicit"] [data-lups-annotation]')).toHaveText('$5.00/kg · Calculated');
  await expect(page.locator('[data-item-id="zero-explicit"]')).toHaveAttribute('data-ppu-sort-value', '5');
  expect(pageErrors).toEqual([]);
});

test('Walmart clears and rebuilds state when a recycled card loses its product identity', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript({ content: userscript });
  await page.route('https://www.walmart.ca/orchestra/snb/graphql/search*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ data: { search: { itemStacks: [{ itemsV2: [
      { id: 'original', name: 'Original rice 1 kg', priceInfo: { currentPrice: { price: 6 } } },
      { id: 'other', name: 'Other rice 1 kg', priceInfo: { currentPrice: { price: 2 } } },
      { id: 'eggs', name: 'Eggs 12 count', priceInfo: { currentPrice: { price: 6 }, unitPrice: { priceString: '$0.50/each' } } },
      { id: 'replacement', name: 'Replacement rice 1 kg', priceInfo: { currentPrice: { price: 1 } } }
    ] }] } } })
  }));
  await page.route('https://www.walmart.ca/recycled-identity-fixture*', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><style>#grid{display:flex}.wrapper,.card{width:140px;height:100px}</style>
      <div id="grid">
        <div class="wrapper" data-name="recycled"><div class="card" data-item-id="original"><span data-automation-id="product-price">$6.00</span></div></div>
        <div class="wrapper" data-name="other"><div class="card" data-item-id="other"><span data-automation-id="product-price">$2.00</span></div></div>
        <div class="wrapper" data-name="eggs"><div class="card" data-item-id="eggs"><span data-automation-id="product-price">$6.00</span></div></div>
      </div><script>fetch('/orchestra/snb/graphql/search?variables=' + encodeURIComponent(JSON.stringify({query:'rice',page:1})))</script>`
  }));

  await page.goto('https://www.walmart.ca/recycled-identity-fixture?q=rice');
  const recycled = page.locator('[data-name="recycled"] .card');
  await expect(recycled.locator('.price-per-unit-info')).toHaveText('$6.00/kg · Calculated');
  await page.locator('#lups-auto-sort').click();
  await expect.poll(() => page.locator('#grid > .wrapper').evaluateAll((wrappers) => wrappers
    .map((wrapper) => ({ name: wrapper.dataset.name, order: Number(wrapper.style.order) }))
    .sort((left, right) => left.order - right.order).map((item) => item.name)))
    .toEqual(['other', 'recycled', 'eggs']);

  await recycled.evaluate((card) => card.removeAttribute('data-item-id'));
  await expect(recycled.locator('.price-per-unit-info')).toHaveCount(0);
  await expect(recycled).not.toHaveAttribute('data-ppu-data-source');
  await expect(recycled).not.toHaveAttribute('data-ppu-total-price');
  await expect(recycled).not.toHaveAttribute('data-ppu-sort-value');
  await expect(page.locator('[data-name="other"] .price-per-unit-info')).toHaveText('$2.00/kg · Calculated');

  await recycled.evaluate((card) => card.setAttribute('data-item-id', 'replacement'));
  await expect(recycled.locator('.price-per-unit-info')).toHaveText('$1.00/kg · Calculated');
  await expect(recycled).toHaveAttribute('data-ppu-data-source', 'api');
  await expect.poll(() => page.locator('#grid > .wrapper').evaluateAll((wrappers) => wrappers
    .map((wrapper) => ({ name: wrapper.dataset.name, order: Number(wrapper.style.order) }))
    .sort((left, right) => left.order - right.order).map((item) => item.name)))
    .toEqual(['recycled', 'other', 'eggs']);

  await recycled.evaluate((card) => card.setAttribute('data-item-id', ''));
  await expect(recycled.locator('.price-per-unit-info')).toHaveCount(0);
  await expect(recycled).not.toHaveAttribute('data-ppu-data-source');
  await expect(recycled).not.toHaveAttribute('data-ppu-sort-dimension');
  expect(pageErrors).toEqual([]);
});

test('Walmart reads message schema once and commits batch updates transactionally', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('https://www.walmart.ca/transaction-fixture*', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><style>#grid{display:flex}.wrapper,.card{width:140px;height:100px}</style><div id="grid">
      <div class="wrapper" data-name="a"><div class="card" data-item-id="a"></div></div>
      <div class="wrapper" data-name="b"><div class="card" data-item-id="b"></div></div>
      <div class="wrapper" data-name="c"><div class="card" data-item-id="c"></div></div>
    </div>`
  }));
  await page.goto('https://www.walmart.ca/transaction-fixture?q=rice');
  await page.addScriptTag({ content: userscript });
  const context = {
    query: 'rice', page: 1, storeId: null,
    pageUrlAtRequest: '/transaction-fixture?q=rice',
    pageUrlAtCapture: '/transaction-fixture?q=rice'
  };
  const initialReads = await page.evaluate((context) => {
    let lengthReads = 0;
    let indexReads = 0;
    const products = new Proxy([
      { id: 'a', name: 'Rice A 1 kg', price: 2, requestSequence: 1 },
      { id: 'b', name: 'Rice B 1 kg', price: 3, requestSequence: 1 }
    ], {
      get(target, property, receiver) {
        if (property === 'length') {
          lengthReads += 1;
          return lengthReads === 1 ? 2 : 1_000_000_000;
        }
        if (/^\d+$/.test(String(property))) indexReads += 1;
        return Reflect.get(target, property, receiver);
      }
    });
    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: location.origin,
      data: {
        source: 'walmart-price-per-unit', version: 2, type: 'api-products', mode: 'snapshot', revision: 1, context,
        products
      }
    }));
    return { lengthReads, indexReads };
  }, context);
  expect(initialReads).toEqual({ lengthReads: 1, indexReads: 2 });
  await expect(page.locator('[data-item-id="a"] .price-per-unit-info')).toHaveText('$2.00/kg · Calculated');
  await expect(page.locator('[data-item-id="b"] .price-per-unit-info')).toHaveText('$3.00/kg · Calculated');
  await expect(page.locator('[data-item-id="c"] .price-per-unit-info')).toHaveCount(0);
  await page.evaluate((context) => window.postMessage({
    source: 'walmart-price-per-unit', version: 2, type: 'api-products', mode: 'snapshot', revision: 2, context,
    products: [
      { id: 'a', name: 'Duplicate one 1 kg', price: 10, requestSequence: 2 },
      { id: 'a', name: 'Duplicate two 1 kg', price: 20, requestSequence: 2 }
    ]
  }, location.origin), context);
  await page.waitForTimeout(0);
  await expect(page.locator('[data-item-id="a"] .price-per-unit-info')).toHaveText('$2.00/kg · Calculated');
  await expect(page.locator('[data-item-id="b"] .price-per-unit-info')).toHaveText('$3.00/kg · Calculated');
  await page.locator('#lups-auto-sort').click();

  await page.evaluate((context) => {
    let reads = 0;
    const message = {
      source: 'walmart-price-per-unit', version: 2, type: 'api-products', revision: 2, context,
      products: [{ id: 'c', name: 'Rice C 1 kg', price: 1, requestSequence: 2 }]
    };
    Object.defineProperty(message, 'mode', {
      enumerable: true,
      get() { reads += 1; window.__gppuWalmartModeReads = reads; return reads === 1 ? 'batch' : 'snapshot'; }
    });
    window.dispatchEvent(new MessageEvent('message', { source: window, origin: location.origin, data: message }));
  }, context);
  await expect(page.locator('.price-per-unit-info')).toHaveCount(3);
  expect(await page.evaluate(() => window.__gppuWalmartModeReads)).toBe(1);
  await expect.poll(() => page.locator('#grid > .wrapper').evaluateAll((wrappers) => wrappers
    .map((wrapper) => ({ name: wrapper.dataset.name, order: Number(wrapper.style.order) }))
    .sort((left, right) => left.order - right.order).map((item) => item.name)))
    .toEqual(['c', 'a', 'b']);

  await page.evaluate((context) => {
    const message = {
      source: 'walmart-price-per-unit', version: 2, type: 'api-products', mode: 'snapshot', context,
      products: [{ id: 'c', name: 'Only C', price: 9, requestSequence: 3 }]
    };
    Object.defineProperty(message, 'revision', { get() { throw new Error('throwing revision'); } });
    window.dispatchEvent(new MessageEvent('message', { source: window, origin: location.origin, data: message }));
    document.querySelector('#grid').classList.toggle('retailer-update');
  }, context);
  await page.waitForTimeout(250);
  await expect(page.locator('.price-per-unit-info')).toHaveCount(3);
  await expect(page.locator('[data-item-id="c"] .price-per-unit-info')).toHaveText('$1.00/kg · Calculated');
  expect(pageErrors).toEqual([]);
});

test('Walmart rejects an extreme revision without freezing ordinary updates', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('https://www.walmart.ca/revision-fixture*', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><div id="grid"><div class="wrapper"><div class="card" data-item-id="rice"></div></div></div>'
  }));
  await page.goto('https://www.walmart.ca/revision-fixture?q=rice');
  await page.addScriptTag({ content: userscript });
  const context = {
    query: 'rice', page: 1, storeId: null,
    pageUrlAtRequest: '/revision-fixture?q=rice',
    pageUrlAtCapture: '/revision-fixture?q=rice'
  };
  const send = (revision, price) => page.evaluate(({ context: messageContext, revision: messageRevision, price: productPrice }) => window.postMessage({
    source: 'walmart-price-per-unit', version: 2, type: 'api-products', mode: 'snapshot',
    revision: messageRevision,
    context: messageContext,
    products: [{ id: 'rice', name: 'Rice 1 kg', price: productPrice, requestSequence: messageRevision }]
  }, location.origin), { context, revision, price });

  await send(1, 2);
  const annotation = page.locator('[data-item-id="rice"] .price-per-unit-info');
  await expect(annotation).toHaveText('$2.00/kg · Calculated');
  await send(Number.MAX_SAFE_INTEGER, 999);
  await page.waitForTimeout(250);
  await expect(annotation).toHaveText('$2.00/kg · Calculated');
  await send(2, 3);
  await expect(annotation).toHaveText('$3.00/kg · Calculated');
  expect(pageErrors).toEqual([]);
});

test('generated userscript claims one engine and preserves chosen order after reinjection', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('https://www.walmart.ca/reinjection-fixture*', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><style>#grid{display:flex}.wrapper,.card{width:140px;height:90px}</style><div id="grid">
      <div class="wrapper" data-name="high"><div class="card" data-item-id="high"></div></div>
      <div class="wrapper" data-name="low"><div class="card" data-item-id="low"></div></div>
      <div class="wrapper" data-name="eggs"><div class="card" data-item-id="eggs"></div></div>
    </div>`
  }));
  await page.goto('https://www.walmart.ca/reinjection-fixture?q=rice');
  await page.addScriptTag({ content: userscript });
  await page.addScriptTag({ content: userscript });
  await expect(page.locator('#lups-control')).toHaveCount(1);
  expect(await page.evaluate(() => globalThis[Symbol.for('grocery-price-per-unit.userscript-install.v1')])).toBe(true);
  const context = {
    query: 'rice', page: 1, storeId: null,
    pageUrlAtRequest: '/reinjection-fixture?q=rice',
    pageUrlAtCapture: '/reinjection-fixture?q=rice'
  };
  await page.evaluate((messageContext) => window.postMessage({
    source: 'walmart-price-per-unit', version: 2, type: 'api-products', mode: 'snapshot', revision: 1,
    context: messageContext,
    products: [
      { id: 'high', name: 'Rice 1 kg', price: 6, requestSequence: 1 },
      { id: 'low', name: 'Rice 1 kg', price: 2, requestSequence: 1 },
      { id: 'eggs', name: 'Eggs 12 each', price: 4, requestSequence: 1 }
    ]
  }, location.origin), context);
  await expect(page.locator('.price-per-unit-info')).toHaveCount(3);
  await page.locator('#lups-auto-sort').click();
  const visualOrder = () => page.locator('#grid > .wrapper').evaluateAll((wrappers) => wrappers
    .map((wrapper) => ({ name: wrapper.dataset.name, order: Number(wrapper.style.order) }))
    .sort((left, right) => left.order - right.order).map((item) => item.name));
  await expect.poll(visualOrder).toEqual(['low', 'high', 'eggs']);
  await page.evaluate(() => {
    window.dispatchEvent(new Event('scroll'));
    document.querySelector('[data-item-id="high"]').classList.toggle('retailer-update');
  });
  await page.waitForTimeout(350);
  await expect.poll(visualOrder).toEqual(['low', 'high', 'eggs']);
  await expect(page.locator('#lups-control')).toHaveCount(1);
  expect(pageErrors).toEqual([]);
});

test('generated userscript fails open and recovers from oversized rendered-card sets', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const cardCount = 1_001;
  const walmartCards = Array.from({ length: cardCount }, (_, index) =>
    `<div class="wrapper"><div class="card" data-item-id="item-${index}"></div></div>`).join('');
  const saveOnCards = Array.from({ length: cardCount }, (_, index) =>
    `<li class="wrapper"><article data-testid="ProductCardWrapper-item-${index}"></article></li>`).join('');
  await page.route('https://www.walmart.ca/oversized-fixture*', (route) => route.fulfill({
    contentType: 'text/html', body: `<!doctype html><div id="grid">${walmartCards}</div>`
  }));
  await page.goto('https://www.walmart.ca/oversized-fixture?q=rice');
  await page.addScriptTag({ content: userscript });
  await page.waitForTimeout(300);
  await expect(page.locator('.price-per-unit-info')).toHaveCount(0);
  await page.locator('#grid').evaluate((grid) => [...grid.children].slice(2).forEach((card) => card.remove()));
  await expect(page.locator('#lups-control')).toHaveCount(1);

  await page.route('https://www.saveonfoods.com/oversized-fixture*', (route) => route.fulfill({
    contentType: 'text/html', body: `<!doctype html><ul id="grid">${saveOnCards}</ul>`
  }));
  await page.goto('https://www.saveonfoods.com/oversized-fixture?q=rice');
  await page.addScriptTag({ content: userscript });
  await page.waitForTimeout(300);
  await expect(page.locator('[data-lups-annotation]')).toHaveCount(0);
  await page.locator('#grid').evaluate((grid) => [...grid.children].slice(2).forEach((card) => card.remove()));
  await expect(page.locator('#lups-control')).toHaveCount(1);
  expect(pageErrors).toEqual([]);
});

test('generated userscript bounds non-product work inside otherwise small grids', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const ordinaryChildren = Array.from({ length: 1_001 }, (_, index) =>
    `<div class="ordinary" data-name="ordinary-${index}"></div>`).join('');
  await page.route('https://www.walmart.ca/non-product-bound-fixture*', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><div id="grid">
      <div class="wrapper"><div data-item-id="one"></div></div>
      <div class="wrapper"><div data-item-id="two"></div></div>
      ${ordinaryChildren}
    </div>`
  }));
  await page.goto('https://www.walmart.ca/non-product-bound-fixture?q=rice');
  await page.evaluate(() => {
    const nativeQuerySelectorAll = Element.prototype.querySelectorAll;
    window.__gppuWrapperProductQueries = 0;
    Element.prototype.querySelectorAll = function boundedQuerySelectorAll(selector) {
      if (selector === '[data-item-id]') window.__gppuWrapperProductQueries += 1;
      return nativeQuerySelectorAll.call(this, selector);
    };
  });
  await page.addScriptTag({ content: userscript });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__gppuWrapperProductQueries)).toBeLessThan(50);
  await expect(page.locator('#lups-control')).toHaveCount(0);
  await page.locator('#grid').evaluate((grid) => grid.querySelectorAll('.ordinary').forEach((node) => node.remove()));
  await expect(page.locator('#lups-control')).toHaveCount(1);

  const promotionMarkers = Array.from({ length: 1_001 }, (_, index) =>
    `<li class="promo" data-name="promo-${index}"><article><div class="pfg-shimmer"><svg aria-label="Loading sponsored product"></svg></div></article></li>`).join('');
  await page.route('https://www.saveonfoods.com/non-product-bound-fixture*', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><ul id="grid">
      <li><article data-testid="ProductCardWrapper-one"></article></li>
      <li><article data-testid="ProductCardWrapper-two"></article></li>
      ${promotionMarkers}
    </ul>`
  }));
  await page.goto('https://www.saveonfoods.com/non-product-bound-fixture?q=rice');
  await page.addScriptTag({ content: userscript });
  await page.waitForTimeout(300);
  await expect(page.locator('.promo').first()).not.toHaveCSS('display', 'none');
  await page.locator('#grid').evaluate((grid) => [...grid.querySelectorAll('.promo')].slice(1).forEach((node) => node.remove()));
  await expect(page.locator('.promo')).toHaveCSS('display', 'none');
  expect(pageErrors).toEqual([]);
});

test('Walmart userscript avoids redundant scans after one API update', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript({ content: userscript });
  await page.addInitScript(() => {
    const measurements = { updates: 0, cardQueries: 0 };
    Object.defineProperty(window, '__gppuMeasurements', { value: measurements });
    window.addEventListener('ppu-products-updated', () => { measurements.updates += 1; });
    const nativeQuerySelectorAll = Document.prototype.querySelectorAll;
    Document.prototype.querySelectorAll = function measuredQuerySelectorAll(selector) {
      if (selector === '[data-item-id]') measurements.cardQueries += 1;
      return nativeQuerySelectorAll.call(this, selector);
    };
  });
  await page.route('https://www.walmart.ca/orchestra/snb/graphql/search*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ data: { search: { itemStacks: [{ itemsV2: [
      { id: 'mass-two', name: 'Rice 2 kg', priceInfo: { currentPrice: { price: 4 } } },
      { id: 'mass-one', name: 'Flour 1 kg', priceInfo: { currentPrice: { price: 1 } } },
      { id: 'mass-new', name: 'Oats 1 kg', priceInfo: { currentPrice: { price: 3 } } }
    ] }] } } })
  }));
  await page.route('https://www.walmart.ca/scan-budget-fixture*', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><style>#grid{display:flex}.wrapper,.card{width:140px;height:90px}</style><div id="grid">
      <div class="wrapper"><div class="card" data-item-id="mass-two"><span data-automation-id="product-price">$4.00</span></div></div>
      <div class="wrapper"><div class="card" data-item-id="mass-one"><span data-automation-id="product-price">$1.00</span></div></div>
    </div>`
  }));

  await page.goto('https://www.walmart.ca/scan-budget-fixture?q=flour');
  await expect(page.locator('#lups-control')).toHaveCount(1);
  await page.waitForTimeout(350);
  await page.evaluate(() => { window.__gppuMeasurements.updates = 0; window.__gppuMeasurements.cardQueries = 0; });
  await page.evaluate(() => fetch('/orchestra/snb/graphql/search?variables=' + encodeURIComponent(JSON.stringify({ query: 'flour', page: 1 }))));
  await expect(page.locator('[data-item-id="mass-one"] .price-per-unit-info')).toContainText('$1.00/kg · Calculated');
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => window.__gppuMeasurements)).toEqual({ updates: 1, cardQueries: 2 });

  await page.evaluate(() => { window.__gppuMeasurements.updates = 0; window.__gppuMeasurements.cardQueries = 0; });
  await page.locator('#grid').evaluate((grid) => grid.insertAdjacentHTML('beforeend', `
    <div class="wrapper"><div class="card" data-item-id="mass-new"><span data-automation-id="product-price">$3.00</span></div></div>`));
  await expect(page.locator('[data-item-id="mass-new"] .price-per-unit-info')).toContainText('$3.00/kg · Calculated');
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => window.__gppuMeasurements)).toEqual({ updates: 1, cardQueries: 2 });

  await page.locator('#lups-auto-sort').click();
  await expect.poll(async () => page.locator('#grid > .wrapper').evaluateAll((wrappers) => wrappers
    .map((wrapper) => ({ id: wrapper.querySelector('[data-item-id]')?.dataset.itemId, order: Number(wrapper.style.order) }))
    .sort((left, right) => left.order - right.order)
    .map(({ id }) => id))).toEqual(['mass-one', 'mass-two', 'mass-new']);
  await page.locator('#grid').evaluate((grid) => grid.setAttribute('data-retailer-render', 'settled'));
  await page.waitForTimeout(350);
  await expect(page.locator('#lups-control')).toHaveAttribute('data-lups-data-state', 'ready');
  await expect(page.locator('#lups-status')).not.toContainText('Website order preserved');
  await expect.poll(async () => page.locator('#grid > .wrapper').evaluateAll((wrappers) => wrappers
    .map((wrapper) => ({ id: wrapper.querySelector('[data-item-id]')?.dataset.itemId, order: Number(wrapper.style.order) }))
    .sort((left, right) => left.order - right.order)
    .map(({ id }) => id))).toEqual(['mass-one', 'mass-two', 'mass-new']);
  await expect(page.locator('#lups-control')).toHaveCount(1);
  expect(pageErrors).toEqual([]);
});

test('Walmart userscript ignores an older response after results navigation', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript({ content: userscript });
  let releaseEggs;
  let signalEggsRequested;
  const eggsGate = new Promise((resolve) => { releaseEggs = resolve; });
  const eggsRequested = new Promise((resolve) => { signalEggsRequested = resolve; });
  await page.route('https://www.walmart.ca/orchestra/snb/graphql/search*', async (route) => {
    const encodedVariables = new URL(route.request().url()).searchParams.get('variables');
    const query = JSON.parse(encodedVariables || '{}').query;
    if (query === 'eggs') {
      signalEggsRequested();
      await eggsGate;
    }
    const itemsV2 = query === 'eggs'
      ? [{ id: 'stale-eggs', name: 'Late Eggs 12 ct', priceInfo: { currentPrice: { price: 1 } } }]
      : [
          { id: 'milk-low', name: 'Milk 4 L', priceInfo: { currentPrice: { price: 4 } } },
          { id: 'milk-high', name: 'Milk 1 L', priceInfo: { currentPrice: { price: 3 } } }
        ];
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { search: { itemStacks: [{ itemsV2 }] } } })
    });
  });
  await page.route('https://www.walmart.ca/stale-results-fixture*', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head><style>
      #grid{display:flex}.wrapper,.card{width:140px;height:90px}
    </style><script>
      document.addEventListener('DOMContentLoaded', () => {
        window.staleSearch = fetch('/orchestra/snb/graphql/search?variables=' + encodeURIComponent(JSON.stringify({query:'eggs',page:1})));
      });
    </script></head><body><div id="grid">
      <div class="wrapper"><div class="card" data-item-id="egg-one"></div></div>
      <div class="wrapper"><div class="card" data-item-id="egg-two"></div></div>
    </div></body></html>`
  }));

  await page.goto('https://www.walmart.ca/stale-results-fixture?q=eggs');
  await eggsRequested;
  await page.evaluate(async () => {
    history.pushState({}, '', '/stale-results-fixture?q=milk');
    document.querySelector('#grid').innerHTML = `
      <div class="wrapper" data-name="milk-low"><div class="card" data-item-id="milk-low"><span data-automation-id="product-price">$4.00</span></div></div>
      <div class="wrapper" data-name="milk-high"><div class="card" data-item-id="milk-high"><span data-automation-id="product-price">$3.00</span></div></div>
      <div class="wrapper" data-name="stale-eggs"><div class="card" data-item-id="stale-eggs"><span data-automation-id="product-price">$1.00</span></div></div>`;
    await fetch('/orchestra/snb/graphql/search?variables=' + encodeURIComponent(JSON.stringify({query:'milk',page:1})));
  });
  await expect(page.locator('[data-name="milk-low"] .price-per-unit-info')).toContainText('$1.00/L · Calculated');
  await expect(page.locator('[data-name="milk-high"] .price-per-unit-info')).toContainText('$3.00/L · Calculated');
  releaseEggs();
  await page.evaluate(() => window.staleSearch);
  await expect(page.locator('[data-name="stale-eggs"] .price-per-unit-info')).toHaveCount(0);
  await expect(page.locator('[data-name="stale-eggs"] [data-ppu-data-source="api"]')).toHaveCount(0);
  await page.locator('#lups-menu-button').click();
  await page.locator('[data-lups-value="auto-asc"]').click();
  await expect(page.locator('#lups-status')).toContainText('2 comparable');
  await expect(page.locator('#lups-live-status')).toContainText('Automatic chose $/L · Low → high · 2 comparable');
  await expect(page.locator('#lups-control')).toHaveCount(1);
  expect(pageErrors).toEqual([]);
});

test('Walmart clears only authoritative empty base pages and recovers safely', async ({ page }) => {
  await page.addInitScript({ content: userscript });
  await page.route('https://www.walmart.ca/orchestra/snb/graphql/search*', (route) => {
    const variables = JSON.parse(new URL(route.request().url()).searchParams.get('variables') || '{}');
    if (variables.mode === 'failed') return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{}'
    });
    if (variables.mode === 'non-json') return route.fulfill({
      contentType: 'text/html',
      body: '{}'
    });
    const itemsV2 = variables.mode === 'empty' || variables.page === 2 ? [] : variables.mode === 'recovered'
      ? [{ id: 'fresh-milk', name: 'Fresh Milk 1 L', priceInfo: { currentPrice: { price: 3 } } }]
      : [
          { id: 'milk-one', name: 'Milk 1 L', priceInfo: { currentPrice: { price: 4 } } },
          { id: 'milk-two', name: 'Milk 2 L', priceInfo: { currentPrice: { price: 6 } } }
        ];
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { search: { itemStacks: [{ itemsV2 }] } } })
    });
  });
  await page.route('https://www.walmart.ca/authoritative-empty-fixture*', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><style>#grid{display:flex}.wrapper,.card{width:140px;height:90px}</style><div id="grid">
      <div class="wrapper"><div class="card" data-item-id="milk-one"></div></div>
      <div class="wrapper"><div class="card" data-item-id="milk-two"></div></div>
      <div class="wrapper"><div class="card" data-item-id="fresh-milk"></div></div>
    </div>`
  }));
  await page.goto('https://www.walmart.ca/authoritative-empty-fixture?q=milk');
  const request = (variables) => page.evaluate((value) => fetch('/orchestra/snb/graphql/search?variables=' + encodeURIComponent(JSON.stringify(value))), variables);

  await request({ query: 'milk', page: 1 });
  await expect(page.locator('.price-per-unit-info')).toHaveCount(2);
  await request({ query: 'milk', page: 1, mode: 'failed' });
  await request({ query: 'milk', page: 1, mode: 'non-json' });
  await request({ query: 'milk', page: 2 });
  await expect(page.locator('.price-per-unit-info')).toHaveCount(2);

  await request({ query: 'milk', page: 1, mode: 'empty' });
  await expect(page.locator('.price-per-unit-info')).toHaveCount(0);
  await expect(page.locator('[data-ppu-data-source="api"]')).toHaveCount(0);

  await request({ query: 'milk', page: 1, mode: 'recovered' });
  await expect(page.locator('[data-item-id="fresh-milk"] .price-per-unit-info')).toHaveText('$3.00/L · Calculated');
});

test('Walmart rejects pagination requested before a refreshed same-query base page', async ({ page }) => {
  await page.addInitScript({ content: userscript });
  let releaseOldPage;
  let signalOldPage;
  const oldPageGate = new Promise((resolve) => { releaseOldPage = resolve; });
  const oldPageRequested = new Promise((resolve) => { signalOldPage = resolve; });
  await page.route('https://www.walmart.ca/orchestra/snb/graphql/search*', async (route) => {
    const variables = JSON.parse(new URL(route.request().url()).searchParams.get('variables') || '{}');
    if (variables.page === 2) {
      signalOldPage();
      await oldPageGate;
    }
    const itemsV2 = variables.page === 2
      ? [{ id: 'stale-page', name: 'Stale Milk 1 L', priceInfo: { currentPrice: { price: 1 } } }]
      : variables.generation === 'new'
        ? [{ id: 'fresh-base', name: 'Fresh Milk 1 L', priceInfo: { currentPrice: { price: 3 } } }]
        : [{ id: 'old-base', name: 'Old Milk 1 L', priceInfo: { currentPrice: { price: 4 } } }];
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { search: { itemStacks: [{ itemsV2 }] } } })
    });
  });
  await page.route('https://www.walmart.ca/pagination-race-fixture*', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><style>#grid{display:flex}.wrapper,.card{width:140px;height:90px}</style><div id="grid">
      <div class="wrapper"><div class="card" data-item-id="old-base"></div></div>
      <div class="wrapper"><div class="card" data-item-id="fresh-base"></div></div>
      <div class="wrapper"><div class="card" data-item-id="stale-page"></div></div>
    </div>`
  }));
  await page.goto('https://www.walmart.ca/pagination-race-fixture?q=milk');
  await page.evaluate(() => fetch('/orchestra/snb/graphql/search?variables=' + encodeURIComponent(JSON.stringify({ query: 'milk', page: 1 }))));
  await expect(page.locator('[data-item-id="old-base"] .price-per-unit-info')).toHaveCount(1);

  await page.evaluate(() => {
    window.oldWalmartPage = fetch('/orchestra/snb/graphql/search?variables=' + encodeURIComponent(JSON.stringify({ query: 'milk', page: 2 })));
  });
  await oldPageRequested;
  await page.evaluate(() => fetch('/orchestra/snb/graphql/search?variables=' + encodeURIComponent(JSON.stringify({ query: 'milk', page: 1, generation: 'new' }))));
  await expect(page.locator('[data-item-id="fresh-base"] .price-per-unit-info')).toHaveCount(1);
  releaseOldPage();
  await page.evaluate(() => window.oldWalmartPage);
  await expect(page.locator('[data-item-id="stale-page"] .price-per-unit-info')).toHaveCount(0);
  await expect(page.locator('[data-item-id="old-base"] .price-per-unit-info')).toHaveCount(0);
});

test('Walmart clears same-query prices when the page/store context changes', async ({ page }) => {
  await page.addInitScript({ content: userscript });
  await page.route('https://www.walmart.ca/orchestra/snb/graphql/search*', (route) => {
    const variables = JSON.parse(new URL(route.request().url()).searchParams.get('variables') || '{}');
    const price = variables.store === 'beta' ? 5 : 4;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { search: { itemStacks: [{ itemsV2: [
        { id: 'scoped-milk', name: 'Scoped Milk 1 L', priceInfo: { currentPrice: { price } } },
        { id: 'scoped-cream', name: 'Scoped Cream 1 L', priceInfo: { currentPrice: { price: price + 1 } } }
      ] }] } } })
    });
  });
  await page.route('https://www.walmart.ca/store-scope-fixture*', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><style>#grid{display:flex}.wrapper,.card{width:140px;height:90px}</style><div id="grid">
      <div class="wrapper"><div class="card" data-item-id="scoped-milk"></div></div>
      <div class="wrapper"><div class="card" data-item-id="scoped-cream"></div></div>
    </div>`
  }));
  await page.goto('https://www.walmart.ca/store-scope-fixture?q=milk&store=alpha');
  const annotation = page.locator('[data-item-id="scoped-milk"] .price-per-unit-info');
  await page.evaluate(() => fetch('/orchestra/snb/graphql/search?variables=' + encodeURIComponent(JSON.stringify({ query: 'milk', page: 1, store: 'alpha' }))));
  await expect(annotation).toHaveText('$4.00/L · Calculated');
  await page.locator('#lups-auto-sort').click();
  await expect(page.locator('#lups-control')).toHaveAttribute('data-lups-data-state', 'ready');

  await page.evaluate(() => {
    history.pushState({}, '', '/store-scope-fixture?q=milk&store=beta');
  });
  await expect(annotation).toHaveCount(0);
  await expect(page.locator('[data-item-id="scoped-milk"]')).not.toHaveAttribute('data-ppu-data-source', 'api');
  await expect(page.locator('#lups-status')).toHaveText('Waiting for current-page product data · Website order preserved · 2 loaded products');

  await page.evaluate(() => fetch('/orchestra/snb/graphql/search?variables=' + encodeURIComponent(JSON.stringify({ query: 'milk', page: 1, store: 'alpha' }))));
  await expect(annotation).toHaveCount(0);
  await expect(page.locator('[data-item-id="scoped-milk"]')).not.toHaveAttribute('data-ppu-data-source', 'api');

  await page.evaluate(() => fetch('/orchestra/snb/graphql/search?variables=' + encodeURIComponent(JSON.stringify({ query: 'milk', page: 1, store: 'beta' }))));
  await expect(annotation).toHaveText('$5.00/L · Calculated');
  await expect(page.locator('#lups-control')).toHaveAttribute('data-lups-data-state', 'ready');
  await expect(page.locator('#lups-status')).not.toContainText('Website order preserved');
});

test('Walmart annotates a cached lazy card during continuous retailer DOM churn', async ({ page }) => {
  await page.addInitScript({ content: userscript });
  await page.route('https://www.walmart.ca/orchestra/snb/graphql/search*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ data: { search: { itemStacks: [{ itemsV2: [
      { id: 'churn-base', name: 'Base Flour 1 kg', priceInfo: { currentPrice: { price: 2 } } },
      { id: 'churn-lazy', name: 'Lazy Flour 1 kg', priceInfo: { currentPrice: { price: 1 } } }
    ] }] } } })
  }));
  await page.route('https://www.walmart.ca/churn-fixture*', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><style>#grid{display:flex}.wrapper,.card{width:140px;height:90px}</style>
      <div id="retailer-churn"></div><div id="grid">
        <div class="wrapper"><div class="card" data-item-id="churn-base"></div></div>
      </div><script>fetch('/orchestra/snb/graphql/search?variables=' + encodeURIComponent(JSON.stringify({query:'flour',page:1})));</script>`
  }));

  await page.goto('https://www.walmart.ca/churn-fixture?q=flour');
  await expect(page.locator('[data-item-id="churn-base"] .price-per-unit-info')).toHaveText('$2.00/kg · Calculated');
  await page.evaluate(() => {
    const churn = document.querySelector('#retailer-churn');
    window.__walmartChurnStopped = false;
    window.__walmartChurnInterval = setInterval(() => churn.classList.toggle('active'), 25);
    const wrapper = document.createElement('div');
    wrapper.className = 'wrapper';
    wrapper.innerHTML = '<div class="card" data-item-id="churn-lazy"></div>';
    document.querySelector('#grid').append(wrapper);
    window.__walmartChurnStopTimer = setTimeout(() => {
      clearInterval(window.__walmartChurnInterval);
      window.__walmartChurnStopped = true;
    }, 2_000);
  });
  await expect(page.locator('[data-item-id="churn-lazy"] .price-per-unit-info'))
    .toHaveText('$1.00/kg · Calculated', { timeout: 1_200 });
  expect(await page.evaluate(() => window.__walmartChurnStopped)).toBe(false);
  await page.evaluate(() => {
    clearInterval(window.__walmartChurnInterval);
    clearTimeout(window.__walmartChurnStopTimer);
  });
});

test('Save-On userscript merges bootstrap and page-two API products from document-start', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript({ content: userscript });
  await page.route('https://storefrontgateway.saveonfoods.com/api/stores/6632/search*', (route) => {
    const requestedPage = new URL(route.request().url()).searchParams.get('page');
    const cors = { 'access-control-allow-origin': 'https://www.saveonfoods.com' };
    if (requestedPage === '90') return route.fulfill({
      status: 500,
      contentType: 'application/json',
      headers: cors,
      body: JSON.stringify({ items: [{
        sku: 'failed-product', name: 'Failed Product', priceNumeric: 1, unitPrice: '$0.01 each'
      }] })
    });
    if (requestedPage === '91') return route.fulfill({
      contentType: 'text/plain',
      headers: cors,
      body: JSON.stringify({ items: [{
        sku: 'non-json-product', name: 'Non JSON Product', priceNumeric: 1, unitPrice: '$0.01 each'
      }] })
    });
    return route.fulfill({
      contentType: 'application/json',
      headers: cors,
      body: JSON.stringify({ items: [{
        sku: 'page-two',
        name: 'Page Two Eggs',
        priceNumeric: 3,
        unitPrice: '$0.25 each',
        unitOfSize: { size: 12, type: 'each' }
      }] })
    });
  });
  await page.route('https://storefrontgateway.saveonfoods.com/api/account*', (route) => route.fulfill({
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': 'https://www.saveonfoods.com' },
    body: JSON.stringify({ items: [{
      sku: 'unrelated', name: 'Unrelated Product', priceNumeric: 1, unitPrice: '$0.01 each'
    }] })
  }));
  await page.route('https://www.saveonfoods.com/sm/pickup/rsid/6632/results*', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head><style>
      #grid,#carousel{display:flex;flex-wrap:wrap}.wrapper,article{width:150px;height:100px}
    </style><script>
      window.__PRELOADED_STATE__ = {search:{
        products:{searchResults:['page-one','mass-one']},
        productCardDictionary:{
          'page-one':{sku:'page-one',name:'Page One Eggs',priceNumeric:6,unitPrice:'$0.50 each',unitOfSize:{size:12,type:'each'}},
          'mass-one':{sku:'mass-one',name:'Flour 1 kg',priceNumeric:2,unitPrice:'$0.20/100g',unitOfSize:{size:1,abbreviation:'kg'}}
        }
      }};
      document.addEventListener('DOMContentLoaded', async () => {
        await fetch('https://storefrontgateway.saveonfoods.com/api/stores/6632/search?q=eggs&take=30&skip=30&page=2');
        await fetch('https://storefrontgateway.saveonfoods.com/api/account?q=eggs');
      });
    </script></head><body><ul id="carousel">
      <li class="wrapper" data-name="carousel-overlap"><article data-testid="ProductCardWrapper-page-one"></article></li>
      <li class="wrapper" data-name="carousel-only"><article data-testid="ProductCardWrapper-carousel-only"></article></li>
    </ul><ul id="grid">
      <li class="wrapper" data-name="page-one"><article data-testid="ProductCardWrapper-page-one"></article></li>
      <li class="wrapper" data-name="mass-one"><article data-testid="ProductCardWrapper-mass-one"></article></li>
      <li class="wrapper" data-name="page-two"><article data-testid="ProductCardWrapper-page-two"></article></li>
      <li class="wrapper" data-name="unrelated"><article data-testid="ProductCardWrapper-unrelated"></article></li>
      <li class="wrapper" data-name="failed-product"><article data-testid="ProductCardWrapper-failed-product"></article></li>
      <li class="wrapper" data-name="non-json-product"><article data-testid="ProductCardWrapper-non-json-product"></article></li>
    </ul></body></html>`
  }));

  await page.goto('https://www.saveonfoods.com/sm/pickup/rsid/6632/results?q=eggs');
  await expect(page.locator('[data-name="page-one"] [data-lups-annotation]')).toHaveText('$0.50/each · Retailer');
  await expect(page.locator('[data-name="page-one"] [data-lups-annotation]')).toHaveAttribute('aria-label', '$0.50 each, unit price supplied by the retailer API');
  await expect(page.locator('[data-name="page-two"] [data-lups-annotation]')).toContainText('$0.25/each · Retailer');
  await expect(page.locator('[data-name="mass-one"] [data-lups-annotation]')).toContainText('$2.00/kg · Retailer');
  await expect(page.locator('[data-name="unrelated"] [data-lups-annotation]')).toHaveCount(0);
  await page.evaluate(() => Promise.all([
    fetch('https://storefrontgateway.saveonfoods.com/api/stores/6632/search?q=eggs&page=90'),
    fetch('https://storefrontgateway.saveonfoods.com/api/stores/6632/search?q=eggs&page=91')
  ]));
  await expect(page.locator('[data-name="page-one"] [data-lups-annotation]')).toContainText('$0.50/each · Retailer');
  await expect(page.locator('[data-name="page-two"] [data-lups-annotation]')).toContainText('$0.25/each · Retailer');
  await expect(page.locator('[data-name="unrelated"] [data-lups-annotation]')).toHaveCount(0);
  await expect(page.locator('[data-name="failed-product"] [data-lups-annotation]')).toHaveCount(0);
  await expect(page.locator('[data-name="non-json-product"] [data-lups-annotation]')).toHaveCount(0);
  await expect(page.locator('#carousel [data-lups-annotation]')).toHaveCount(0);
  expect(await page.locator('#carousel > .wrapper').evaluateAll((cards) => cards.every((card) => !card.style.order))).toBe(true);
  await page.locator('#lups-menu-button').click();
  await page.locator('[data-lups-value="auto-asc"]').click();
  await expect(page.locator('#lups-status')).toContainText('2 comparable');
  await expect(page.locator('#lups-live-status')).toContainText('Automatic chose $/each · Low → high · 2 comparable');
  await expect(page.locator('#lups-status')).toContainText('Loaded range $0.25–$0.50/each');
  await expect(page.locator('#lups-status')).toContainText('1 different-unit product follows');
  const orderedNames = await page.locator('#grid > .wrapper').evaluateAll((wrappers) => wrappers
    .map((wrapper) => ({ name: wrapper.dataset.name, order: Number(wrapper.style.order) }))
    .sort((left, right) => left.order - right.order)
    .map(({ name }) => name));
  expect(orderedNames.slice(0, 3)).toEqual(['page-two', 'page-one', 'mass-one']);
  await expect(page.locator('#lups-control')).toHaveCount(1);
  expect(pageErrors).toEqual([]);
});

test('Save-On userscript ignores a late response from the previous results query', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript({ content: userscript });
  let releaseEggs;
  let signalEggsRequested;
  const eggsGate = new Promise((resolve) => { releaseEggs = resolve; });
  const eggsRequested = new Promise((resolve) => { signalEggsRequested = resolve; });
  await page.route('https://storefrontgateway.saveonfoods.com/api/stores/6632/search*', async (route) => {
    const query = new URL(route.request().url()).searchParams.get('q');
    if (query === 'eggs') {
      signalEggsRequested();
      await eggsGate;
    }
    const items = query === 'eggs'
      ? [{ sku: 'stale-eggs', name: 'Late Eggs', priceNumeric: 1, unitPrice: '$0.08 each' }]
      : [
          { sku: 'milk-low', name: 'Milk 4 L', priceNumeric: 4, unitPrice: '$0.10/100ml' },
          { sku: 'milk-high', name: 'Milk 1 L', priceNumeric: 3, unitPrice: '$0.30/100ml' }
        ];
    await route.fulfill({
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': 'https://www.saveonfoods.com' },
      body: JSON.stringify({ items })
    });
  });
  await page.route('https://www.saveonfoods.com/sm/pickup/rsid/6632/results*', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head><style>
      #grid{display:flex}.wrapper,article{width:150px;height:100px}
    </style><script>
      document.addEventListener('DOMContentLoaded', () => {
        window.staleSearch = fetch('https://storefrontgateway.saveonfoods.com/api/stores/6632/search?q=eggs');
      });
    </script></head><body><ul id="grid">
      <li class="wrapper"><article data-testid="ProductCardWrapper-egg-one"></article></li>
      <li class="wrapper"><article data-testid="ProductCardWrapper-egg-two"></article></li>
    </ul></body></html>`
  }));

  await page.goto('https://www.saveonfoods.com/sm/pickup/rsid/6632/results?q=eggs');
  await eggsRequested;
  await page.evaluate(async () => {
    history.pushState({}, '', '/sm/pickup/rsid/6632/results?q=milk');
    document.querySelector('#grid').innerHTML = `
      <li class="wrapper" data-name="milk-low"><article data-testid="ProductCardWrapper-milk-low"></article></li>
      <li class="wrapper" data-name="milk-high"><article data-testid="ProductCardWrapper-milk-high"></article></li>
      <li class="wrapper" data-name="stale-eggs"><article data-testid="ProductCardWrapper-stale-eggs"></article></li>`;
    await fetch('https://storefrontgateway.saveonfoods.com/api/stores/6632/search?q=milk');
  });
  await expect(page.locator('[data-name="milk-low"] [data-lups-annotation]')).toContainText('$1.00/L · Retailer');
  await expect(page.locator('[data-name="milk-high"] [data-lups-annotation]')).toContainText('$3.00/L · Retailer');
  releaseEggs();
  await page.evaluate(() => window.staleSearch);
  await expect(page.locator('[data-name="stale-eggs"] [data-lups-annotation]')).toHaveCount(0);
  await expect(page.locator('[data-name="milk-low"] [data-lups-annotation]')).toContainText('$1.00/L · Retailer');
  await expect(page.locator('#lups-control')).toHaveCount(1);
  expect(pageErrors).toEqual([]);
});

test('Save-On rejects a throwing snapshot transaction without losing accepted prices', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript({ content: userscript });
  await page.route('https://www.saveonfoods.com/sm/pickup/rsid/6632/results*', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head><style>#grid{display:flex}.wrapper,article{width:150px;height:100px}</style>
      <script>window.__PRELOADED_STATE__={search:{products:{searchResults:['milk-high','milk-low']},productCardDictionary:{
        'milk-high':{sku:'milk-high',name:'Milk 1 L',priceNumeric:4,unitPrice:'$0.40/100ml'},
        'milk-low':{sku:'milk-low',name:'Milk 4 L',priceNumeric:6,unitPrice:'$0.15/100ml'}
      }}};</script></head><body><ul id="grid">
        <li class="wrapper" data-name="milk-high"><article data-testid="ProductCardWrapper-milk-high"></article></li>
        <li class="wrapper" data-name="milk-low"><article data-testid="ProductCardWrapper-milk-low"></article></li>
      </ul></body></html>`
  }));

  await page.goto('https://www.saveonfoods.com/sm/pickup/rsid/6632/results?q=milk');
  const high = page.locator('[data-name="milk-high"] [data-lups-annotation]');
  const low = page.locator('[data-name="milk-low"] [data-lups-annotation]');
  await expect(high).toHaveText('$4.00/L · Retailer');
  await expect(low).toHaveText('$1.50/L · Retailer');
  await page.locator('#lups-auto-sort').click();
  const initialOrder = await page.locator('#grid > .wrapper').evaluateAll((wrappers) => wrappers
    .map((wrapper) => ({ name: wrapper.dataset.name, order: Number(wrapper.style.order) }))
    .sort((left, right) => left.order - right.order).map((item) => item.name));
  expect(initialOrder).toEqual(['milk-low', 'milk-high']);

  await page.evaluate(() => {
    const throwingProduct = new Proxy({}, { get() { throw new Error('hostile getter'); } });
    window.__gppuRejectedSaveOnRevision = (window[Symbol.for('saveon-price-per-unit.api-capture.v1')]?.revision || 0) + 10;
    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: location.origin,
      data: {
        source: 'saveon-price-per-unit', version: 2, type: 'api-products', mode: 'snapshot',
        revision: window.__gppuRejectedSaveOnRevision,
        context: { query: 'milk', pagePath: '/sm/pickup/rsid/6632/results?q=milk' },
        products: [
          { id: 'milk-high', name: 'Partially read update', currentPrice: 5, unitPrice: '$0.50/100ml' },
          throwingProduct
        ]
      }
    }));
    document.querySelector('#grid').append(document.createElement('span'));
  });
  await page.waitForTimeout(250);
  await expect(high).toHaveText('$4.00/L · Retailer');
  await expect(low).toHaveText('$1.50/L · Retailer');
  await expect.poll(() => page.locator('#grid > .wrapper').evaluateAll((wrappers) => wrappers
    .map((wrapper) => ({ name: wrapper.dataset.name, order: Number(wrapper.style.order) }))
    .sort((left, right) => left.order - right.order).map((item) => item.name)))
    .toEqual(['milk-low', 'milk-high']);

  await page.evaluate(() => window.postMessage({
    source: 'saveon-price-per-unit', version: 2, type: 'api-products', mode: 'snapshot',
    revision: window.__gppuRejectedSaveOnRevision,
    context: { query: 'milk', pagePath: '/sm/pickup/rsid/6632/results?q=milk' },
    products: [
      { id: 'milk-high', name: 'Accepted update', currentPrice: 5, unitPrice: '$0.50/100ml' },
      { id: 'milk-low', name: 'Milk 4 L', currentPrice: 6, unitPrice: '$0.15/100ml' }
    ]
  }, location.origin));
  await expect(high).toHaveText('$5.00/L · Retailer');
  expect(pageErrors).toEqual([]);
});

test('Save-On userscript hides only sponsored placeholders', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('https://www.saveonfoods.com/test-fixture*', (route) => route.fulfill({
    body: `<!doctype html><html><head><style>
      #grid{display:flex}.wrapper{width:140px;height:80px}article{width:130px;height:70px}
    </style></head><body><ul id="grid">
      <li class="wrapper"><article data-testid="ProductCardWrapper-one"></article></li>
      <li class="wrapper"><article data-testid="ProductCardWrapper-two"></article></li>
      <li class="wrapper" data-name="sponsored" style="display:grid"><article><div class="pfg-shimmer"><svg aria-label="Loading sponsored product"></svg></div></article></li>
      <li class="wrapper" data-name="ordinary-content"><article>Ordinary non-product content</article></li>
    </ul></body></html>`,
    contentType: 'text/html'
  }));
  await page.goto('https://www.saveonfoods.com/test-fixture?q=milk');
  await page.addScriptTag({ content: userscript });

  await expect(page.locator('#lups-control')).toHaveCount(1);
  const sponsored = page.locator('[data-name="sponsored"]');
  const marker = sponsored.locator('[aria-label]');
  await expect(sponsored).toHaveCSS('display', 'none');
  await expect(page.locator('[data-name="ordinary-content"]')).not.toHaveCSS('display', 'none');
  await marker.evaluate((node) => node.setAttribute('aria-label', 'Loading ordinary content'));
  await expect(sponsored).toHaveCSS('display', 'grid');
  await marker.evaluate((node) => node.setAttribute('aria-label', 'Loading sponsored product'));
  await expect(sponsored).toHaveCSS('display', 'none');
  expect(pageErrors).toEqual([]);
});

test('userscript metadata keeps capture and UI in the page world', async () => {
  expect(userscript).toContain('// @inject-into page');
  expect(userscript).toContain('// @grant       none');
  expect(userscript).not.toContain('// @inject-into content');
  expect(userscript).not.toMatch(/\/\/ @grant\s+GM\./);
});
