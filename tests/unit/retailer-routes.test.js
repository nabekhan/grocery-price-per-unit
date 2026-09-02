import { describe, expect, it } from 'vitest';
import { isLoblawSearchPage } from '../../src/retailers/loblaw/routes.js';
import { isSaveOnSearchPage } from '../../src/retailers/saveon/routes.js';
import { isWalmartSearchPage } from '../../src/retailers/walmart/routes.js';

const url = (value) => new URL(value);

describe('retailer-owned search-page selectors', () => {
  it.each([
    ['https://www.realcanadiansuperstore.ca/en/search?', isLoblawSearchPage],
    ['https://www.realcanadiansuperstore.ca/search?search-bar=milk', isLoblawSearchPage],
    ['https://www.nofrills.ca/legacy-results?search-bar=eggs', isLoblawSearchPage],
    ['https://www.walmart.ca/en/search?', isWalmartSearchPage],
    ['https://www.walmart.ca/legacy-results?q=milk', isWalmartSearchPage],
    ['https://www.saveonfoods.com/sm/pickup/rsid/6647/results?', isSaveOnSearchPage],
    ['https://www.saveonfoods.com/sm/delivery/rsid/1234/results?q=eggs', isSaveOnSearchPage],
    ['https://www.saveonfoods.com/legacy-results?q=milk', isSaveOnSearchPage]
  ])('accepts search route %s', (value, selector) => {
    expect(selector(url(value))).toBe(true);
  });

  it.each([
    ['https://www.realcanadiansuperstore.ca/en/food/dairy-eggs', isLoblawSearchPage],
    ['https://www.realcanadiansuperstore.ca/en/product/milk/123', isLoblawSearchPage],
    ['https://www.walmart.ca/en/grocery', isWalmartSearchPage],
    ['https://www.walmart.ca/en/ip/milk/600000000001', isWalmartSearchPage],
    ['https://www.saveonfoods.com/sm/pickup/rsid/6647/categories/dairy', isSaveOnSearchPage],
    ['https://www.saveonfoods.com/sm/pickup/rsid/6647/product/milk/123', isSaveOnSearchPage]
  ])('rejects non-search route %s', (value, selector) => {
    expect(selector(url(value))).toBe(false);
  });
});
