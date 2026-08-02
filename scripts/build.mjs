import { build } from 'esbuild';
import fs from 'node:fs/promises';

await fs.rm('dist/extension', { recursive: true, force: true });
await fs.mkdir('dist/extension', { recursive: true });
const common = { bundle: true, format: 'iife', target: ['safari14'], legalComments: 'none', minify: false };
await build({ ...common, entryPoints: ['src/retailers/loblaw/content.js'], outfile: 'dist/extension/loblaw-content.js' });
await build({
  entryPoints: ['src/retailers/loblaw/api-capture-main.js'],
  bundle: true,
  format: 'iife',
  target: ['safari18'],
  legalComments: 'none',
  minify: false,
  outfile: 'dist/extension/loblaw-api-capture-main.js'
});
await fs.copyFile('manifest.json', 'dist/extension/manifest.json');
for (const size of [16, 48, 128]) await fs.copyFile(`assets/icon${size}.png`, `dist/extension/icon${size}.png`);
for (const file of ['popup.html', 'popup.js', 'popup.css']) await fs.copyFile(`extension/${file}`, `dist/extension/${file}`);
await build({ ...common, entryPoints: ['src/retailers/walmart/content.js'], outfile: 'dist/extension/walmart-content.js' });
await build({ ...common, entryPoints: ['src/retailers/walmart/sort-main.js'], outfile: 'dist/extension/walmart-sort.js' });
await build({ ...common, entryPoints: ['src/retailers/walmart/api-capture-main.js'], target: ['safari18'], outfile: 'dist/extension/walmart-api-capture-main.js' });
await build({ ...common, entryPoints: ['src/retailers/saveon/content.js'], outfile: 'dist/extension/saveon-content.js' });
await build({ ...common, entryPoints: ['src/retailers/saveon/api-capture-main.js'], target: ['safari18'], outfile: 'dist/extension/saveon-api-capture-main.js' });
