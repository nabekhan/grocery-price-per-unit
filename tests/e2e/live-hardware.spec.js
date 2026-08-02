import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';

const captureScript = await fs.readFile('dist/extension/api-capture-main.js', 'utf8');
const contentScript = await fs.readFile('dist/extension/content.js', 'utf8');
const queries = [
  'hammer', 'screwdriver', 'extension cord', 'light bulbs', 'storage bin',
  'frying pan', 'kitchen utensils', 'snow shovel', 'door mat', 'batteries',
  'picture frame', 'garden hose'
];

test('hardware and home-goods fallback probe', async ({ page }) => {
  test.skip(process.env.LIVE_SITE !== '1', 'Set LIVE_SITE=1 to contact the live storefront.');
  test.setTimeout(180_000);
  const results = [];
  for (const query of queries) {
    const response = await page.goto(`https://www.realcanadiansuperstore.ca/search?search-bar=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(4000);
    const titlesBefore = await page.locator('[data-testid="product-title"]').count();
    if (titlesBefore < 3) {
      results.push({ query, http: response?.status(), outcome: 'no-grid', titles: titlesBefore });
      continue;
    }
      await page.addScriptTag({ content: captureScript });
      await page.addScriptTag({ content: contentScript });
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
    results.push({ query, http: response?.status(), outcome: 'pass', titles: titlesBefore, status, ...gridReport });
  }
  console.info(`LIVE_HARDWARE_RESULTS=${JSON.stringify(results)}`);
  expect(results.filter((result) => result.outcome === 'pass').length).toBeGreaterThanOrEqual(8);
});
