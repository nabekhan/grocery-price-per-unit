/*!
 * Walmart plugin entry. Capture, annotation, sorting, and their trusted model
 * WeakMap share one generated IIFE, so page code cannot replace the model
 * channel through globals, attributes, or forged events.
 */
import { defineRetailerPlugin, installRetailerPlugin } from '../../runtime/retailer-plugin.js';
import { installWalmartCapture } from './api-capture-main.js';
import { getWalmartScope, installWalmartAnnotator } from './content.js';
import { installWalmartSorter } from './sort-main.js';
import { isWalmartSearchPage } from './routes.js';

const plugin = defineRetailerPlugin({
  id: 'walmart',
  hostnames: ['www.walmart.ca'],
  isSearchPage: isWalmartSearchPage,
  getScope: () => getWalmartScope(),
  installCapture: (global) => installWalmartCapture(global),
  installRuntime: (_global, context) => {
    const annotatorInstalled = installWalmartAnnotator(context);
    const sorterInstalled = installWalmartSorter(context);
    return annotatorInstalled !== false || sorterInstalled !== false;
  }
});

installRetailerPlugin(plugin, window);
