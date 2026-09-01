import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const screenshotRoot = path.join(root, 'artifacts/screenshots');
await fs.mkdir(screenshotRoot, { recursive: true });
await Promise.all([
  // Remove legacy multi-target evidence as well as current userscript output,
  // so an old extension matrix or popup cannot look current after this run.
  'control-state-matrix',
  'userscript-control-state-matrix',
  'popup',
  'control-obstruction'
].map((directory) => fs.rm(path.join(screenshotRoot, directory), { recursive: true, force: true })));
await Promise.all([
  'visual-audit-report.html',
  'visual-audit-report-preview.png',
  'visual-audit-manifest.json',
  'visual-audit-report.html.tmp',
  'visual-audit-manifest.json.tmp',
  'visual-audit-manifest.json.preview.tmp'
].map((filename) => fs.rm(path.join(screenshotRoot, filename), { force: true })));
