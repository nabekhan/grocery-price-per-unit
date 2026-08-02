import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const sorter = await fs.readFile(path.resolve('dist/extension/walmart-sort.js'), 'utf8');

async function fixture(page) {
  const installExtensionMock = () => {
    globalThis.chrome = {
      storage: {
        sync: {
          get(_defaults, callback) { callback({ defaultSortMode: 'auto-asc' }); },
          set() {}
        },
        onChanged: { addListener() {} }
      }
    };
  };
  await page.addInitScript(installExtensionMock);
  await page.setContent(`<!doctype html><html><head><style>
    [aria-label="Sort and Filter section"]{display:flex;align-items:center;gap:8px}
    #grid{display:flex;flex-wrap:wrap}.wrapper{width:140px;height:80px}.card{width:130px;height:70px}
  </style></head><body>
    <div aria-label="Sort and Filter section"><div class="ld_Cl"><button aria-label="Sort by Relevance"><span>Relevance</span></button></div></div>
    <div id="grid">
      <div class="wrapper" data-name="m3"><div class="card" data-item-id="m3" data-ppu-sort-dimension="mass" data-ppu-sort-value="3" data-ppu-total-price="7"></div></div>
      <div class="wrapper" data-name="v8"><div class="card" data-item-id="v8" data-ppu-sort-dimension="volume" data-ppu-sort-value="8" data-ppu-total-price="5"></div></div>
      <div class="wrapper" data-name="m1"><div class="card" data-item-id="m1" data-ppu-sort-dimension="mass" data-ppu-sort-value="1" data-ppu-total-price="6"></div></div>
      <div class="wrapper" data-name="c4"><div class="card" data-item-id="c4" data-ppu-sort-dimension="count" data-ppu-sort-value="4" data-ppu-total-price="3"></div></div>
      <div class="wrapper" data-name="m2"><div class="card" data-item-id="m2" data-ppu-sort-dimension="mass" data-ppu-sort-value="2" data-ppu-total-price="4"></div></div>
      <div class="wrapper" data-name="v2"><div class="card" data-item-id="v2" data-ppu-sort-dimension="volume" data-ppu-sort-value="2" data-ppu-total-price="2"></div></div>
      <div class="wrapper" data-name="unknown"><div class="card" data-item-id="u" data-ppu-total-price="1"></div></div>
    </div>
  </body></html>`);
  await page.evaluate(installExtensionMock);
  await page.addScriptTag({ content: sorter });
  await expect(page.locator('#lups-control')).toHaveCount(1);
}

async function visualOrder(page) {
  return page.locator('#grid > .wrapper').evaluateAll((items) => items
    .map((item) => ({ name: item.dataset.name, order: Number(item.style.order) }))
    .sort((a, b) => a.order - b.order)
    .map((item) => item.name));
}

test('Walmart uses the shared predominant-unit ordering and polished menu', async ({ page }) => {
  await fixture(page);
  await expect.poll(() => visualOrder(page)).toEqual(['m1', 'm2', 'm3', 'v2', 'v8', 'c4', 'unknown']);
  await page.locator('#lups-menu-button').click();
  await expect(page.locator('#lups-menu')).toBeVisible();
  await expect(page.locator('#lups-control')).toHaveAttribute('data-lups-floating', 'true');
  await expect(page.locator('#lups-mode option')).toHaveCount(11);
});

test('Walmart re-sorts newly appended last-page items', async ({ page }) => {
  await fixture(page);
  await page.locator('#grid').evaluate((grid) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'wrapper';
    wrapper.dataset.name = 'm0';
    wrapper.innerHTML = '<div class="card" data-item-id="m0" data-ppu-sort-dimension="mass" data-ppu-sort-value="0.5" data-ppu-total-price="9"></div>';
    grid.append(wrapper);
    window.dispatchEvent(new CustomEvent('ppu-products-updated'));
  });
  await expect.poll(() => visualOrder(page)).toEqual(['m0', 'm1', 'm2', 'm3', 'v2', 'v8', 'c4', 'unknown']);
});
