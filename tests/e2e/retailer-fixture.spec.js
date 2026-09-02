import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const userscript = await fs.readFile(path.join(root, 'dist/userscript/Grocery Price Per Unit.user.js'), 'utf8');

async function mockStorage(page) {
  await page.addInitScript(() => {
    globalThis.chrome = {
      storage: {
        sync: {
          async get() { return { defaultSortMode: 'auto-asc' }; },
          async set() {}
        },
        onChanged: { addListener() {} }
      }
    };
  });
}

async function openSaveOn(page) {
  await mockStorage(page);
  await page.route('https://www.saveonfoods.com/test-fixture*', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><style>
    section{display:flex;gap:8px;align-items:center}ul{display:flex;flex-wrap:wrap;padding:0}li{display:block;width:150px;height:100px}article{height:90px}
  </style><ul id="carousel">
    <li data-name="carousel-overlap"><article data-testid="ProductCardWrapper-milk-high"></article></li>
    <li data-name="carousel-only"><article data-testid="ProductCardWrapper-carousel-only"></article></li>
  </ul><section><button data-testid="toggleSortByButton"><span>Relevance</span></button></section><ul id="grid">
    <li data-name="milk-high"><article data-testid="ProductCardWrapper-milk-high"></article></li>
    <li data-name="eggs"><article data-testid="ProductCardWrapper-eggs"></article></li>
    <li data-name="milk-low"><article data-testid="ProductCardWrapper-milk-low"></article></li>
    <li data-name="sponsored-one"><article><div class="pfg-shimmer"><svg aria-label="Loading sponsored product"></svg></div></article></li>
    <li data-name="sponsored-two"><article><div class="pfg-shimmer"><svg aria-label="Loading sponsored product"></svg></div></article></li>
    <li data-name="ordinary-content"><article>Ordinary non-product content</article></li>
  </ul>` }));
  await page.goto('https://www.saveonfoods.com/test-fixture?q=milk');
  await page.addScriptTag({ content: userscript });
  await page.evaluate(() => window.postMessage({
    source: 'saveon-price-per-unit', version: 2, type: 'api-products', mode: 'snapshot', revision: 1,
    context: { query: 'milk', pagePath: '/test-fixture?q=milk' },
    products: [
      { id: 'milk-high', name: 'Milk 1 L', currentPrice: 4, unitPrice: '$0.40/100ml', unitOfSize: { size: 1, abbreviation: 'l' } },
      { id: 'eggs', name: 'Eggs 12 each', currentPrice: 6, unitPrice: '$0.50/each', unitOfSize: { size: 12, abbreviation: 'each' } },
      { id: 'milk-low', name: 'Milk 4 L', currentPrice: 6, unitPrice: '$0.15/100ml', unitOfSize: { size: 4, abbreviation: 'l' } }
    ]
  }, location.origin));
  await expect(page.locator('#lups-control')).toHaveCount(1);
  await page.locator('#lups-auto-sort').click();
}

async function visualOrder(page, selector) {
  return page.locator(selector).evaluateAll((items) => items.map((item) => ({ name: item.dataset.name, order: Number(item.style.order) }))
    .sort((a, b) => a.order - b.order).map((item) => item.name));
}

test('Save-On uses its API model with the shared predominant sorter', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await openSaveOn(page);
  await expect.poll(() => visualOrder(page, '#grid > li:has(article[data-testid^="ProductCardWrapper-"])'))
    .toEqual(['milk-low', 'milk-high', 'eggs']);
  await expect(page.locator('[data-lups-annotation]')).toHaveCount(3);
  await expect(page.locator('#carousel [data-lups-annotation]')).toHaveCount(0);
  expect(await page.locator('#carousel > li').evaluateAll((cards) => cards.every((card) => !card.style.order))).toBe(true);
  await expect(page.locator('#lups-status')).toContainText('3 loaded products');
  await expect(page.locator('#lups-control')).toHaveAttribute('data-lups-floating', 'true');
  await expect(page.locator('[data-name="sponsored-one"]')).toHaveCSS('display', 'none');
  await expect(page.locator('[data-name="sponsored-two"]')).toHaveCSS('display', 'none');
  await expect(page.locator('[data-name="ordinary-content"]')).not.toHaveCSS('display', 'none');
  await expect(page.locator('#lups-status')).toContainText('2 sponsored/ad tiles hidden');

  await page.evaluate(() => window.postMessage({
    source: 'saveon-price-per-unit', version: 2, type: 'api-products', mode: 'snapshot', revision: 2,
    context: { query: 'milk', pagePath: '/test-fixture?q=milk' }, products: null
  }, location.origin));
  await page.waitForTimeout(0);
  expect(pageErrors).toEqual([]);

  await page.locator('#lups-menu-button').click();
  await page.locator('[data-lups-value="restore"]').click();
  await expect(page.locator('[data-name="sponsored-one"]')).toHaveCSS('display', 'none');
  await expect(page.locator('[data-name="sponsored-two"]')).toHaveCSS('display', 'none');
  await expect(page.locator('[data-name="ordinary-content"]')).not.toHaveCSS('display', 'none');
  await expect(page.locator('#lups-status-row')).toBeVisible();
  await expect(page.locator('#lups-status')).toHaveText('Website order · 2 sponsored/ad tiles hidden');
  await expect(page.locator('#lups-restore')).toBeHidden();
});

test('Save-On reads the bounded bridge array length exactly once', async ({ page }) => {
  await openSaveOn(page);
  const reads = await page.evaluate(() => {
    let lengthReads = 0;
    let indexReads = 0;
    const products = new Proxy([
      { id: 'milk-high', name: 'Milk 1 L', currentPrice: 4, unitPrice: '$0.40/100ml' },
      { id: 'eggs', name: 'Eggs', currentPrice: 6, unitPrice: '$0.50/each' },
      { id: 'milk-low', name: 'Milk 4 L', currentPrice: 6, unitPrice: '$0.15/100ml' }
    ], {
      get(target, property, receiver) {
        if (property === 'length') {
          lengthReads += 1;
          return lengthReads === 1 ? 3 : 1_000_000_000;
        }
        if (/^\d+$/.test(String(property))) indexReads += 1;
        return Reflect.get(target, property, receiver);
      }
    });
    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: location.origin,
      data: {
        source: 'saveon-price-per-unit', version: 2, type: 'api-products', mode: 'snapshot', revision: 2,
        context: { query: 'milk', pagePath: '/test-fixture?q=milk' },
        products
      }
    }));
    return { lengthReads, indexReads };
  });
  expect(reads).toEqual({ lengthReads: 1, indexReads: 3 });
  await expect(page.locator('[data-lups-annotation]')).toHaveCount(3);
  await page.evaluate(() => window.postMessage({
    source: 'saveon-price-per-unit', version: 2, type: 'api-products', mode: 'snapshot', revision: 3,
    context: { query: 'milk', pagePath: '/test-fixture?q=milk' },
    products: [
      { id: 'milk-high', name: 'Duplicate one', currentPrice: 8, unitPrice: '$0.80/100ml' },
      { id: 'milk-high', name: 'Duplicate two', currentPrice: 12, unitPrice: '$1.20/100ml' }
    ]
  }, location.origin));
  await page.waitForTimeout(0);
  await expect(page.locator('[data-lups-annotation]')).toHaveCount(3);
  await expect(page.locator('[data-name="milk-high"] [data-lups-annotation]')).toHaveText('$4.00/L · Retailer');
});

test('Save-On content claims one long-lived runtime when reinjected', async ({ page }) => {
  await mockStorage(page);
  await page.route('https://www.saveonfoods.com/reinjection-fixture*', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><ul id="grid">
      <li><article data-testid="ProductCardWrapper-one"></article></li>
      <li><article data-testid="ProductCardWrapper-two"></article></li>
    </ul>`
  }));
  await page.goto('https://www.saveonfoods.com/reinjection-fixture?q=milk');
  await page.evaluate(() => {
    const nativeSetInterval = window.setInterval;
    window.__gppuScopeWatcherInstalls = 0;
    window.setInterval = function measuredSetInterval(callback, delay, ...args) {
      if (delay === 200) window.__gppuScopeWatcherInstalls += 1;
      return nativeSetInterval.call(this, callback, delay, ...args);
    };
  });
  await page.addScriptTag({ content: userscript });
  await page.addScriptTag({ content: userscript });
  await expect(page.locator('#lups-control')).toHaveCount(1);
  expect(await page.evaluate(() => window.__gppuScopeWatcherInstalls)).toBe(1);
  expect(await page.evaluate(() => globalThis[Symbol.for('grocery-price-per-unit.runtime.saveon-content.v1')])).toBe(true);
});

test('Save-On clears same-query prices across a pickup-route transition', async ({ page }) => {
  await openSaveOn(page);
  await expect(page.locator('[data-lups-annotation]')).toHaveCount(3);

  await page.evaluate(() => {
    history.pushState({}, '', '/sm/pickup/rsid/9999/results?q=milk');
  });
  await expect(page.locator('[data-lups-annotation]')).toHaveCount(0);
  await expect(page.locator('[data-name="sponsored-one"]')).toHaveCSS('display', 'none');
  await expect(page.locator('[data-name="sponsored-two"]')).toHaveCSS('display', 'none');
  await expect(page.locator('#lups-status')).toHaveText('Waiting for current-page product data · Website order preserved · 3 loaded products · 2 sponsored/ad tiles hidden');
  await expect(page.locator('#lups-live-status')).toHaveText('Waiting for current-page product data · Website order preserved · 3 loaded products · 2 sponsored/ad tiles hidden');

  await page.locator('#grid').evaluate((grid) => {
    window.__detachedSaveOnLists = [document.querySelector('#carousel'), grid];
    for (const list of window.__detachedSaveOnLists) list.remove();
  });
  await expect(page.locator('#lups-status')).toHaveText('Waiting for current-page product data · Website order preserved');
  await expect(page.locator('#lups-live-status')).toHaveText('Waiting for current-page product data · Website order preserved');
  expect(await page.evaluate(() => [...window.__detachedSaveOnLists[1].children]
    .filter((item) => item.dataset.name?.startsWith('sponsored-'))
    .every((item) => item.style.display !== 'none'))).toBe(true);
  await page.evaluate(() => document.body.append(...window.__detachedSaveOnLists));
  await expect(page.locator('#lups-status')).toHaveText('Waiting for current-page product data · Website order preserved · 3 loaded products · 2 sponsored/ad tiles hidden');
  await expect(page.locator('[data-name="sponsored-one"]')).toHaveCSS('display', 'none');

  await page.evaluate(() => window.postMessage({
    source: 'saveon-price-per-unit', version: 2, type: 'api-products', mode: 'snapshot', revision: 2,
    context: { query: 'milk', storeId: '6632', pagePath: '/sm/pickup/rsid/9999/results?q=milk' },
    products: [{ id: 'milk-high', name: 'Stale-store milk', currentPrice: 1, unitPrice: '$0.10/100ml' }]
  }, location.origin));
  await page.waitForTimeout(0);
  await expect(page.locator('[data-lups-annotation]')).toHaveCount(0);

  await page.evaluate(() => window.postMessage({
    source: 'saveon-price-per-unit', version: 2, type: 'api-products', mode: 'snapshot', revision: 2,
    context: { query: 'milk', storeId: '9999', pagePath: '/sm/pickup/rsid/9999/results?q=milk' },
    products: [{ id: 'milk-high', name: 'Milk 1 L', currentPrice: 5, unitPrice: '$0.50/100ml', unitOfSize: { size: 1, abbreviation: 'l' } }]
  }, location.origin));
  await expect(page.locator('[data-lups-annotation]')).toHaveCount(1);
  await expect(page.locator('[data-name="milk-high"] [data-lups-annotation]')).toHaveText('$5.00/L · Retailer');
  await expect(page.locator('#lups-status')).not.toContainText('Website order preserved');
});

test('Save-On annotates a cached lazy card during continuous retailer DOM churn', async ({ page }) => {
  await openSaveOn(page);
  await expect(page.locator('[data-name="milk-low"] [data-lups-annotation]')).toHaveText('$1.50/L · Retailer');
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    document.querySelector('[data-name="milk-low"]').remove();
    const churn = document.createElement('div');
    churn.id = 'saveon-retailer-churn';
    document.body.append(churn);
    window.__saveonChurnStopped = false;
    window.__saveonChurnInterval = setInterval(() => {
      churn.replaceChildren(document.createTextNode(String(Date.now())));
    }, 25);
    document.querySelector('#grid').insertAdjacentHTML('beforeend',
      '<li data-name="milk-low-lazy"><article data-testid="ProductCardWrapper-milk-low"></article></li>');
    window.__saveonChurnStopTimer = setTimeout(() => {
      clearInterval(window.__saveonChurnInterval);
      window.__saveonChurnStopped = true;
    }, 2_000);
  });
  await expect(page.locator('[data-name="milk-low-lazy"] [data-lups-annotation]'))
    .toHaveText('$1.50/L · Retailer', { timeout: 1_200 });
  expect(await page.evaluate(() => window.__saveonChurnStopped)).toBe(false);
  await page.evaluate(() => {
    clearInterval(window.__saveonChurnInterval);
    clearTimeout(window.__saveonChurnStopTimer);
  });
});

test('Save-On preserves website order for an accepted snapshot with no rendered product matches', async ({ page }) => {
  await openSaveOn(page);
  await page.evaluate(() => window.postMessage({
    source: 'saveon-price-per-unit', version: 2, type: 'api-products', mode: 'snapshot', revision: 2,
    context: { query: 'milk', pagePath: '/test-fixture?q=milk' },
    products: [{ id: 'other', name: 'Other', currentPrice: 3, unitOfSize: { size: 1, abbreviation: 'kg' } }]
  }, location.origin));
  await expect(page.locator('[data-name="sponsored-one"]')).toHaveCSS('display', 'none');
  await expect(page.locator('[data-name="sponsored-two"]')).toHaveCSS('display', 'none');
  await expect(page.locator('#lups-status')).toHaveText('No matching product data in these loaded results · Website order preserved · 3 loaded products · 2 sponsored/ad tiles hidden');
  await expect(page.locator('#lups-live-status')).toHaveText('No matching product data in these loaded results · Website order preserved · 3 loaded products · 2 sponsored/ad tiles hidden');
  await expect(page.locator('[data-name="milk-high"]')).toHaveCSS('order', '0');
});

test('Save-On rejects unsafe bridge prices and reconstructs only bounded size fields', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await openSaveOn(page);
  await page.evaluate(() => window.postMessage({
    source: 'saveon-price-per-unit', version: 2, type: 'api-products', mode: 'snapshot', revision: 2,
    context: { query: 'milk', pagePath: '/test-fixture?q=milk' },
    products: [
      { id: 'milk-high', name: 'Milk 1 L', currentPrice: -1, unitOfSize: { size: 1, abbreviation: 'l' } },
      { id: 'eggs', name: 'Eggs 12 each', currentPrice: 1_000_001, unitOfSize: { size: 12, type: 'each' } },
      {
        id: 'milk-low', name: 'Milk 4 L', currentPrice: 6,
        unitOfSize: { size: 4, abbreviation: 'l', nested: { ignored: 'x'.repeat(1000) } }
      }
    ]
  }, location.origin));

  await expect(page.locator('#grid [data-lups-annotation]')).toHaveCount(1);
  await expect(page.locator('[data-name="milk-low"] [data-lups-annotation]')).toHaveText('$1.50/L · Calculated');
  await expect(page.locator('[data-name="milk-high"] [data-lups-annotation]')).toHaveCount(0);
  await expect(page.locator('[data-name="eggs"] [data-lups-annotation]')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('Save-On never ranks zero-price API sentinels as free products', async ({ page }) => {
  await openSaveOn(page);
  await page.evaluate(() => window.postMessage({
    source: 'saveon-price-per-unit', version: 2, type: 'api-products', mode: 'snapshot', revision: 2,
    context: { query: 'milk', pagePath: '/test-fixture?q=milk' },
    products: [
      { id: 'milk-high', name: 'Zero sentinel', currentPrice: 0 },
      { id: 'eggs', name: 'Negative zero sentinel', currentPrice: -0 },
      { id: 'milk-low', name: 'Valid price', currentPrice: 6 }
    ]
  }, location.origin));
  await page.locator('#lups-menu-button').click();
  await page.locator('[data-lups-value="total-asc"]').click();

  await expect.poll(() => visualOrder(page, '#grid > li:has(article[data-testid^="ProductCardWrapper-"])'))
    .toEqual(['milk-low', 'milk-high', 'eggs']);
  await expect(page.locator('[data-name="milk-high"] [data-lups-annotation]')).toHaveCount(0);
  await expect(page.locator('[data-name="eggs"] [data-lups-annotation]')).toHaveCount(0);
  await expect(page.locator('#lups-status')).toContainText('1 priced');
});

test('Save-On rescans a recycled card when only its product identity changes', async ({ page }) => {
  await openSaveOn(page);
  await page.evaluate(() => window.postMessage({
    source: 'saveon-price-per-unit', version: 2, type: 'api-products', mode: 'snapshot', revision: 2,
    context: { query: 'milk', pagePath: '/test-fixture?q=milk' },
    products: [
      { id: 'milk-high', name: 'Milk 1 L', currentPrice: 4, unitPrice: '$0.40/100ml' },
      { id: 'eggs', name: 'Eggs', currentPrice: 6, unitPrice: '$0.50/each' },
      { id: 'milk-low', name: 'Milk 4 L', currentPrice: 6, unitPrice: '$0.15/100ml' },
      { id: 'replacement', name: 'Replacement milk', currentPrice: 2, unitPrice: '$0.10/100ml' }
    ]
  }, location.origin));

  const recycled = page.locator('[data-name="milk-high"] article');
  await recycled.evaluate((article) => article.setAttribute('data-testid', 'ProductCardWrapper-replacement'));
  await expect(page.locator('[data-name="milk-high"] [data-lups-annotation]')).toHaveText('$1.00/L · Retailer');
  await expect.poll(() => visualOrder(page, '#grid > li:has(article[data-testid^="ProductCardWrapper-"])'))
    .toEqual(['milk-high', 'milk-low', 'eggs']);

  await recycled.evaluate((article) => article.setAttribute('data-testid', 'ProductCardWrapper-unknown-recycled'));
  await expect(page.locator('[data-name="milk-high"] [data-lups-annotation]')).toHaveCount(0);
  await expect.poll(() => visualOrder(page, '#grid > li:has(article[data-testid^="ProductCardWrapper-"])'))
    .toEqual(['milk-low', 'eggs', 'milk-high']);
});

test('Save-On releases CSS order ownership between userscript sort cycles and grid handoffs', async ({ page }) => {
  await openSaveOn(page);
  await page.locator('#lups-menu-button').click();
  await page.locator('[data-lups-value="restore"]').click();
  const card = page.locator('#grid > [data-name="milk-high"]');
  await card.evaluate((element) => element.style.setProperty('order', '7'));
  await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
  await expect(card).toHaveCSS('order', '7');

  await page.locator('#lups-auto-sort').click();
  await page.locator('#lups-restore').click();
  await expect(card).toHaveCSS('order', '7');
  await card.evaluate((element) => element.style.setProperty('order', '9'));

  await page.evaluate(() => window.postMessage({
    source: 'saveon-price-per-unit', version: 2, type: 'api-products', mode: 'snapshot', revision: 2,
    context: { query: 'milk', pagePath: '/test-fixture?q=milk' },
    products: [
      { id: 'milk-high', name: 'Carousel overlap', currentPrice: 4, unitPrice: '$0.40/100ml' },
      { id: 'carousel-only', name: 'Carousel only', currentPrice: 3, unitPrice: '$0.30/100ml' }
    ]
  }, location.origin));
  await expect(page.locator('#carousel [data-lups-annotation]')).toHaveCount(2);
  await expect(card).toHaveCSS('order', '9');

  await page.evaluate(() => window.postMessage({
    source: 'saveon-price-per-unit', version: 2, type: 'api-products', mode: 'snapshot', revision: 3,
    context: { query: 'milk', pagePath: '/test-fixture?q=milk' },
    products: [
      { id: 'milk-high', name: 'Milk 1 L', currentPrice: 4, unitPrice: '$0.40/100ml' },
      { id: 'eggs', name: 'Eggs 12 each', currentPrice: 6, unitPrice: '$0.50/each' },
      { id: 'milk-low', name: 'Milk 4 L', currentPrice: 6, unitPrice: '$0.15/100ml' }
    ]
  }, location.origin));
  await expect(page.locator('#grid [data-lups-annotation]')).toHaveCount(3);
  await expect(page.locator('#carousel [data-lups-annotation]')).toHaveCount(0);
  await expect(card).toHaveCSS('order', '9');
});

for (const viewport of [{ name: 'phone', width: 390, height: 844 }, { name: 'tablet', width: 768, height: 900 }, { name: 'desktop', width: 1440, height: 900 }]) {
  test(`shared retailer menu fits ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openSaveOn(page);
    await page.locator('#lups-menu-button').click();
    await expect(page.locator('#lups-menu')).toBeVisible();
    const box = await page.locator('#lups-menu').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    await page.screenshot({ path: `artifacts/screenshots/selector-viewports/combined-${viewport.name}.png` });
  });
}
