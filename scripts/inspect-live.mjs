import { webkit } from '@playwright/test';
import fs from 'node:fs/promises';

const site = process.argv[2] || 'https://www.realcanadiansuperstore.ca/search?search-bar=milk';
const label = process.argv[3] || 'inspection';
const browser = await webkit.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-CA' });
const consoleErrors = [];
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
const response = await page.goto(site, { waitUntil: 'domcontentloaded', timeout: 45_000 });
await page.waitForTimeout(8000);
await fs.mkdir('artifacts/screenshots', { recursive: true });
await page.screenshot({ path: `artifacts/screenshots/${label}.png`, fullPage: true });
const report = await page.evaluate(() => {
  const links = [...document.querySelectorAll('a[href*="/product/"], a[href*="/p/"]')];
  const uniqueLinks = [...new Set(links.map((link) => link.href))];
  const samples = uniqueLinks.slice(0, 5).map((href) => {
    const link = links.find((item) => item.href === href);
    let node = link;
    for (let i = 0; i < 6 && node?.parentElement; i += 1) {
      if ((node.innerText || '').match(/\$\s*\d/)) break;
      node = node.parentElement;
    }
    return { href, tag: node?.tagName, attrs: node ? Object.fromEntries([...node.attributes].map((a) => [a.name, a.value])) : {}, text: node?.innerText?.slice(0, 1000) };
  });
  const semantic = [...document.querySelectorAll('[data-testid], [data-test], [role="list"], [role="listitem"], main')]
    .slice(0, 100).map((el) => ({ tag: el.tagName, testid: el.getAttribute('data-testid'), role: el.getAttribute('role'), text: el.innerText?.slice(0, 120) }));
  const cardAncestry = [...document.querySelectorAll('[data-testid="product-title"]')].slice(0, 3).map((title) => {
    const chain = [];
    let node = title;
    for (let i = 0; i < 7 && node; i += 1, node = node.parentElement) chain.push({ tag: node.tagName, testid: node.getAttribute('data-testid'), role: node.getAttribute('role'), cls: node.className, childCount: node.children.length });
    return chain;
  });
  return { title: document.title, url: location.href, bodyText: document.body.innerText.slice(0, 3000), productLinkCount: uniqueLinks.length, samples, cardAncestry, semantic };
});
console.info(JSON.stringify({ status: response?.status(), ...report, consoleErrors: consoleErrors.slice(0, 20) }, null, 2));
await browser.close();
