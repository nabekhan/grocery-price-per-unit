import { defineRetailerPlugin, installRetailerPlugin } from '../../runtime/retailer-plugin.js';
import { installSaveOnCapture } from './api-capture-main.js';
import { getSaveOnScope, installSaveOnRuntime } from './content.js';

const plugin = defineRetailerPlugin({
  id: 'saveon',
  hostnames: ['www.saveonfoods.com'],
  getScope: () => getSaveOnScope(),
  installCapture: (global) => installSaveOnCapture(global),
  installRuntime: (_global, context) => installSaveOnRuntime(context)
});

installRetailerPlugin(plugin, window);
