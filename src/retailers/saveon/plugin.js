import { defineRetailerPlugin, installRetailerPlugin } from '../../runtime/retailer-plugin.js';
import { installSaveOnCapture } from './api-capture-main.js';
import { getSaveOnScope, installSaveOnRuntime } from './content.js';
import { isSaveOnSearchPage } from './routes.js';
import { installSaveOnShoppingList } from './shopping-list.js';

const plugin = defineRetailerPlugin({
  id: 'saveon',
  hostnames: ['www.saveonfoods.com'],
  isSearchPage: isSaveOnSearchPage,
  getScope: () => getSaveOnScope(),
  installCapture: (global) => installSaveOnCapture(global),
  installRuntime: (_global, context) => {
    const contentInstalled = installSaveOnRuntime(context);
    const shoppingInstalled = installSaveOnShoppingList();
    return contentInstalled !== false || shoppingInstalled !== false;
  }
});

installRetailerPlugin(plugin, window);
