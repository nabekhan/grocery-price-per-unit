import { webkit } from '@playwright/test';
import fs from 'node:fs/promises';

/*
 * One low-frequency screenshot/metrics probe for an explicitly supplied live
 * results URL. It installs the exact generated userscript at document start,
 * never clicks page controls, and reports only bounded technical evidence.
 */
if (process.env.LIVE_SITE !== '1') {
  throw new Error('Set LIVE_SITE=1 to contact a live storefront');
}

const allowedHosts = new Set([
  'www.realcanadiansuperstore.ca',
  'www.nofrills.ca',
  'www.walmart.ca',
  'www.saveonfoods.com'
]);
const target = new URL(process.argv[2] || 'https://www.realcanadiansuperstore.ca/search?search-bar=milk');
if (target.protocol !== 'https:' || !allowedHosts.has(target.hostname)) {
  throw new Error(`Unsupported live-inspection origin: ${target.origin}`);
}
const label = process.argv[3] || 'inspection';
if (!/^[a-z0-9-]{1,80}$/.test(label)) throw new Error('Screenshot label must use 1–80 lowercase letters, digits, or hyphens');

const userscript = await fs.readFile('dist/userscript/Grocery Price Per Unit.user.js', 'utf8');
const browser = await webkit.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-CA' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error.message).slice(0, 240)));
  await page.addInitScript({ content: userscript });
  const response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(6000);
  await fs.mkdir('artifacts/screenshots', { recursive: true });
  await page.screenshot({ path: `artifacts/screenshots/live-inspect-${label}.png`, fullPage: false });
  const report = await page.evaluate(() => ({
    page: `${location.origin}${location.pathname}`,
    controls: document.querySelectorAll('#lups-control').length,
    productTitles: document.querySelectorAll('[data-testid="product-title"],[data-item-id]').length,
    annotations: document.querySelectorAll('[data-lups-annotation],.price-per-unit-info').length,
    status: document.querySelector('#lups-status')?.textContent || null,
    dataState: document.querySelector('#lups-control')?.dataset.lupsDataState || null,
    obstructed: document.querySelector('#lups-control')?.dataset.lupsObstructed || null
  }));
  console.info(JSON.stringify({ httpStatus: response?.status(), ...report, errors: errors.slice(0, 20) }, null, 2));
} finally {
  await browser.close();
}
