import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';

const userscript = await fs.readFile('dist/userscript/Grocery Price Per Unit.user.js', 'utf8');
const cases = [
  ['rss', 'https://www.realcanadiansuperstore.ca', 'all purpose flour'],
  ['rss', 'https://www.realcanadiansuperstore.ca', 'sugar'],
  ['rss', 'https://www.realcanadiansuperstore.ca', 'olive oil'],
  ['rss', 'https://www.realcanadiansuperstore.ca', 'onions'],
  ['rss', 'https://www.realcanadiansuperstore.ca', 'garlic'],
  ['rss', 'https://www.realcanadiansuperstore.ca', 'tomatoes'],
  ['rss', 'https://www.realcanadiansuperstore.ca', 'chicken breast'],
  ['rss', 'https://www.realcanadiansuperstore.ca', 'black beans'],
  ['rss', 'https://www.realcanadiansuperstore.ca', 'cheddar cheese'],
  ['rss', 'https://www.realcanadiansuperstore.ca', 'greek yogurt'],
  ['rss', 'https://www.realcanadiansuperstore.ca', 'laundry detergent'],
  ['rss', 'https://www.realcanadiansuperstore.ca', 'toilet paper'],
  ['rss', 'https://www.realcanadiansuperstore.ca', 'shampoo'],
  ['rss', 'https://www.realcanadiansuperstore.ca', 'garbage bags'],
  ['rss', 'https://www.realcanadiansuperstore.ca', 'birthday candles'],
  ['nofrills', 'https://www.nofrills.ca', 'all purpose flour'],
  ['nofrills', 'https://www.nofrills.ca', 'olive oil'],
  ['nofrills', 'https://www.nofrills.ca', 'laundry detergent'],
  ['nofrills', 'https://www.nofrills.ca', 'toilet paper']
];

test('representative ingredient and household matrix', async ({ page }) => {
  test.setTimeout(240_000);
  test.skip(process.env.LIVE_SITE !== '1', 'Set LIVE_SITE=1 to contact live storefronts.');
  await page.addInitScript({ content: userscript });
  const results = [];
  for (const [banner, base, query] of cases) {
    const pageErrors = [];
    const listener = (error) => pageErrors.push(error.message);
    page.on('pageerror', listener);
    const response = await page.goto(`${base}/search?search-bar=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(4500);
    const before = await page.locator('[data-testid="product-title"]').count();
    if (before < 3) {
      results.push({ banner, query, status: response?.status(), outcome: 'no-grid', products: before });
      page.off('pageerror', listener);
      continue;
    }
    const baseline = pageErrors.length;
    await expect(page.locator('#lups-control')).toHaveCount(1);
    await page.locator('#lups-mode').selectOption('total-asc', { force: true });
    await page.locator('#lups-mode').selectOption('auto-asc', { force: true });
    await expect(page.locator('#lups-status')).toContainText('loaded products');
    const status = await page.locator('#lups-status').textContent();
    const after = await page.locator('[data-testid="product-title"]').count();
    const annotations = await page.locator('[data-lups-annotation]').count();
    expect(after).toBe(before);
    expect(annotations).toBeGreaterThan(0);
    expect(pageErrors.slice(baseline)).toEqual([]);
    results.push({ banner, query, status: response?.status(), outcome: 'pass', products: before, annotations, sortStatus: status });
    page.off('pageerror', listener);
  }
  console.info(`LIVE_MATRIX_RESULTS=${JSON.stringify(results)}`);
  expect(results.filter((result) => result.outcome === 'pass').length).toBeGreaterThanOrEqual(15);
});
