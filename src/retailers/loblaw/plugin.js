import { defineRetailerPlugin, installRetailerPlugin } from '../../runtime/retailer-plugin.js';
import { installLoblawCapture } from './api-capture-main.js';
import { getLoblawScope, installLoblawRuntime } from './content.js';
import { isLoblawSearchPage } from './routes.js';
import { installLoblawShoppingList } from './shopping-list.js';

const plugin = defineRetailerPlugin({
  id: 'loblaw',
  hostnames: ['www.realcanadiansuperstore.ca', 'www.nofrills.ca'],
  isSearchPage: isLoblawSearchPage,
  getScope: () => getLoblawScope(),
  installCapture: (global) => installLoblawCapture(global),
  installRuntime: (_global, context, capture) => {
    const contentInstalled = installLoblawRuntime(context);
    const shoppingInstalled = installLoblawShoppingList(capture);
    return contentInstalled !== false || shoppingInstalled !== false;
  }
});

installRetailerPlugin(plugin, window);
