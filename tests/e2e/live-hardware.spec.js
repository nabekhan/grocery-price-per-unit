import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';

const userscript = await fs.readFile('dist/userscript/Grocery Price Per Unit.user.js', 'utf8');
const queries = [
  'hammer', 'screwdriver', 'extension cord', 'light bulbs', 'storage bin',
  'frying pan', 'kitchen utensils', 'snow shovel', 'door mat', 'batteries',
  'picture frame', 'garden hose'
];

test('hardware and home-goods unit-coverage probe', async ({ page }) => {
  test.skip(process.env.LIVE_SITE !== '1', 'Set LIVE_SITE=1 to contact the live storefront.');
  test.setTimeout(180_000);
  await page.addInitScript({ content: userscript });
  const results = [];
  for (const query of queries) {
    const response = await page.goto(`https://www.realcanadiansuperstore.ca/search?search-bar=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(4000);
    const titlesBefore = await page.locator('[data-testid="product-title"]').count();
    if (titlesBefore < 3) {
      results.push({ query, http: response?.status(), outcome: 'no-grid', titles: titlesBefore });
      continue;
    }
    await expect(page.locator('#lups-control')).toHaveCount(1);
    // Force a mode transition so choosing automatic always starts a sort.
    await page.locator('#lups-mode').selectOption('total-asc', { force: true });
    await page.locator('#lups-mode').selectOption('auto-asc', { force: true });
    const status = await page.locator('#lups-status').textContent();
    const gridReport = await page.evaluate(() => {
      const notes = [...document.querySelectorAll('[data-lups-annotation]')];
      return {
        annotations: notes.length,
        retailer: notes.filter((note) => note.dataset.source === 'retailer').length,
        calculated: notes.filter((note) => note.dataset.source === 'calculated').length,
        unavailable: notes.filter((note) => note.dataset.source === 'unknown').length,
        samplePackages: [...document.querySelectorAll('[data-testid="product-package-size"]')].slice(0, 5).map((node) => node.textContent.trim())
      };
    });
    expect(await page.locator('[data-testid="product-title"]').count()).toBe(titlesBefore);
    expect(gridReport.annotations).toBeGreaterThan(0);
    results.push({ query, http: response?.status(), outcome: 'pass', titles: titlesBefore, status, ...gridReport });
  }
  console.info(`LIVE_HARDWARE_RESULTS=${JSON.stringify(results)}`);
  expect(results.filter((result) => result.outcome === 'pass').length).toBeGreaterThanOrEqual(8);
});
