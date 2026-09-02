import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';

const enabled = process.env.LIVE_SITE === '1';
const userscript = await fs.readFile('dist/userscript/Grocery Price Per Unit.user.js', 'utf8');
const relevantPageErrors = (errors) => errors.filter((message) =>
  !/analytics-fe\.digital-cloud\.medallia\.ca\/api\/web\/events.*access control checks/i.test(message));
const installUserscript = (page) => page.addInitScript({ content: userscript });

test.describe('low-frequency live storefront checks', () => {
  test.skip(!enabled, 'Set LIVE_SITE=1 to contact live storefronts.');
  for (const entry of [
    { banner: 'rss', base: 'https://www.realcanadiansuperstore.ca', query: 'milk', dimension: 'volume', guide: true },
    { banner: 'rss', base: 'https://www.realcanadiansuperstore.ca', query: 'eggs', dimension: 'count' },
    { banner: 'rss', base: 'https://www.realcanadiansuperstore.ca', query: 'rice', dimension: 'mass' },
    { banner: 'nofrills', base: 'https://www.nofrills.ca', query: 'milk', dimension: 'volume' }
  ]) test(`${entry.banner} ${entry.query} ${entry.dimension}`, async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await installUserscript(page);
    await page.goto(`${entry.base}/search?search-bar=${entry.query}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    const baselineErrorCount = pageErrors.length;
    const titlesBefore = await page.locator('[data-testid="product-title"]').count();
    test.skip(titlesBefore < 3, 'Storefront did not expose a product grid to this anonymous run.');
    await expect(page.locator('#lups-control')).toHaveCount(1);
    await page.locator('#lups-mode').selectOption(`${entry.dimension}-asc`, { force: true });
    await expect(page.locator('#lups-status')).toContainText('loaded products');
    const report = await page.evaluate((dimension) => {
      const notes = [...document.querySelectorAll('[data-lups-annotation]')];
      const unit = dimension === 'mass' ? 'kg' : dimension === 'volume' ? 'L' : 'each';
      const ordered = notes.map((note, index) => {
        const match = /^\$([0-9]+(?:\.[0-9]+)?)\/(kg|L|each)\b/.exec(note.textContent.trim());
        return {
          note,
          parsed: match ? { value: Number(match[1]), unit: match[2] } : null,
          order: Number.parseInt(note.closest('[style*="order"]')?.style.order || index, 10)
        };
      }).sort((a, b) => a.order - b.order);
      const compatible = ordered.filter(({ parsed }) => parsed?.unit === unit);
      const values = compatible.map(({ parsed }) => parsed.value);
      const firstNonCompatible = ordered.findIndex(({ parsed }) => parsed?.unit !== unit);
      const controls = document.querySelectorAll('#lups-control').length;
      const linksWork = [...document.querySelectorAll('[data-testid="product-title"]')].some((title) => title.closest('a[href]'));
      return { values, monotonic: values.every((value, index) => index === 0 || values[index - 1] <= value), compatibleFirst: firstNonCompatible < 0 || firstNonCompatible >= compatible.length, controls, titleCount: document.querySelectorAll('[data-testid="product-title"]').length, linksWork };
    }, entry.dimension);
    expect(report.values.length).toBeGreaterThan(0);
    expect(report.monotonic).toBe(true);
    expect(report.compatibleFirst).toBe(true);
    expect(report.controls).toBe(1);
    expect(report.titleCount).toBe(titlesBefore);
    expect(report.linksWork).toBe(true);
    expect(relevantPageErrors(pageErrors.slice(baselineErrorCount))).toEqual([]);
    // The site's first-visit privacy layer intentionally intercepts all page clicks.
    // Dispatch directly so the test does not make a consent choice for the user.
    await page.locator('#lups-menu-button').evaluate((button) => button.click());
    await page.locator('[data-lups-value="restore"]').evaluate((button) => button.click());
    await expect(page.locator('#lups-status')).toContainText('Website order');
    await page.screenshot({ path: `artifacts/screenshots/live-${entry.banner}-${entry.query}.png`, fullPage: false });
    if (entry.guide) {
      await page.locator('#lups-menu-button').evaluate((button) => button.click());
      await expect(page.locator('#lups-menu [role="menuitemradio"]')).toHaveCount(6);
      await expect(page.locator('#lups-default')).toBeVisible();
      await page.screenshot({ path: `artifacts/screenshots/live-${entry.banner}-${entry.query}-menu.png`, fullPage: false });
    }
  });

  test('rss SPA search navigation, duplicate prevention, and normal scrolling', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await installUserscript(page);
    await page.goto('https://www.realcanadiansuperstore.ca/search?search-bar=milk', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    test.skip(await page.locator('[data-testid="product-title"]').count() < 3, 'No anonymous product grid.');
    await page.locator('#lups-mode').selectOption('volume-asc', { force: true });
    const initialCount = await page.locator('[data-testid="product-title"]').count();
    const baselineErrorCount = pageErrors.length;

    // Exercise the storefront's own lazy-loading path without clicking cart or consent controls.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1200);
    }
    const afterScrollCount = await page.locator('[data-testid="product-title"]').count();
    await expect(page.locator('#lups-control')).toHaveCount(1);

    const search = page.locator('[data-testid="autocomplete-input"]').first();
    await search.fill('eggs');
    await search.press('Enter');
    await expect(page).toHaveURL(/search-bar=eggs/i, { timeout: 20_000 });
    await expect(page.locator('[data-testid="product-title"]').first()).toBeVisible();
    await expect(page.locator('#lups-control')).toHaveCount(1);
    await page.locator('#lups-mode').selectOption('count-asc', { force: true });
    await expect(page.locator('#lups-status')).toContainText('/each');
    await expect(page.locator('#lups-menu-button-text')).toContainText('$/each');
    expect(relevantPageErrors(pageErrors.slice(baselineErrorCount))).toEqual([]);
    test.info().annotations.push({ type: 'loaded-results', description: `Initial titles ${initialCount}; after normal scroll ${afterScrollCount}.` });
    await page.screenshot({ path: 'artifacts/screenshots/live-rss-spa-eggs.png', fullPage: false });
  });

  test('rss bell pepper sorts every API-backed result card', async ({ page }) => {
    await installUserscript(page);
    await page.goto('https://www.realcanadiansuperstore.ca/search?search-bar=bell%20pepper', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    test.skip(await page.locator('[data-testid="product-title"]').count() < 3, 'No anonymous product grid.');
    await page.locator('#lups-mode').selectOption('mass-asc', { force: true });
    const cards = page.locator('[data-lups-data-source]');
    expect(await cards.count()).toBeGreaterThan(0);
    await expect(cards.locator('[data-lups-annotation]')).toHaveCount(await cards.count());
    await expect(page.locator('#lups-status')).toContainText('loaded products');
  });
});
