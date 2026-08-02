import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const saveonScript = await fs.readFile(path.join(root, 'dist/extension/saveon-content.js'), 'utf8');
const popupHtml = await fs.readFile(path.join(root, 'extension/popup.html'), 'utf8');
const popupCss = await fs.readFile(path.join(root, 'extension/popup.css'), 'utf8');

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
  </style><section><button data-testid="toggleSortByButton"><span>Relevance</span></button></section><ul id="grid">
    <li data-name="milk-high"><article data-testid="ProductCardWrapper-milk-high"></article></li>
    <li data-name="eggs"><article data-testid="ProductCardWrapper-eggs"></article></li>
    <li data-name="milk-low"><article data-testid="ProductCardWrapper-milk-low"></article></li>
  </ul>` }));
  await page.goto('https://www.saveonfoods.com/test-fixture?q=milk');
  await page.addScriptTag({ content: saveonScript });
  await page.evaluate(() => window.postMessage({
    source: 'saveon-price-per-unit', version: 1, type: 'api-products', mode: 'snapshot', revision: 1,
    context: { query: 'milk', pagePath: '/test-fixture?q=milk' },
    products: {
      'milk-high': { id: 'milk-high', name: 'Milk 1 L', currentPrice: 4, unitPrice: '$0.40/100ml', unitOfSize: { size: 1, abbreviation: 'l' } },
      eggs: { id: 'eggs', name: 'Eggs 12 each', currentPrice: 6, unitPrice: '$0.50/each', unitOfSize: { size: 12, abbreviation: 'each' } },
      'milk-low': { id: 'milk-low', name: 'Milk 4 L', currentPrice: 6, unitPrice: '$0.15/100ml', unitOfSize: { size: 4, abbreviation: 'l' } }
    }
  }, location.origin));
  await expect(page.locator('#lups-control')).toHaveCount(1);
}

async function visualOrder(page, selector) {
  return page.locator(selector).evaluateAll((items) => items.map((item) => ({ name: item.dataset.name, order: Number(item.style.order) }))
    .sort((a, b) => a.order - b.order).map((item) => item.name));
}

test('Save-On uses its API model with the shared predominant sorter', async ({ page }) => {
  await openSaveOn(page);
  await expect.poll(() => visualOrder(page, '#grid > li')).toEqual(['milk-low', 'milk-high', 'eggs']);
  await expect(page.locator('[data-lups-annotation]')).toHaveCount(3);
  await expect(page.locator('#lups-control')).toHaveAttribute('data-lups-floating', 'true');
});

test('popup store links form a balanced two-by-two grid', async ({ page }) => {
  await page.setContent(popupHtml.replace('<link rel="stylesheet" href="popup.css">', `<style>${popupCss}</style>`));
  const boxes = await page.locator('.retailer-grid a').evaluateAll((links) => links.map((link) => {
    const box = link.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width };
  }));
  expect(boxes).toHaveLength(4);
  expect(boxes[0].x).toBe(boxes[2].x);
  expect(boxes[1].x).toBe(boxes[3].x);
  expect(boxes[0].y).toBe(boxes[1].y);
  expect(boxes[2].y).toBe(boxes[3].y);
  expect(boxes.every((box) => box.width === boxes[0].width)).toBe(true);
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
