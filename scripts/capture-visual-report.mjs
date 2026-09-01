import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { webkit } from '@playwright/test';

const report = path.resolve('artifacts/screenshots/visual-audit-report.html');
const preview = path.resolve('artifacts/screenshots/visual-audit-report-preview.png');
const manifestPath = path.resolve('artifacts/screenshots/visual-audit-manifest.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const expectedDecodedImages = Object.keys(manifest.controlStates).length
  + manifest.accessibilityStates.forcedColorsControl.images.length
  + Object.keys(manifest.obstructionStates).length;
const browser = await webkit.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(report).href);
  await page.waitForLoadState('load');
  const decodedImages = await page.locator('img').evaluateAll(async (images) => {
    for (const item of images) item.loading = 'eager';
    await Promise.all(images.map((item) => item.decode()));
    if (images.some((item) => !item.complete || item.naturalWidth === 0 || item.naturalHeight === 0)) {
      throw new Error('Visual report contains an undecodable image.');
    }
    return images.length;
  });
  if (decodedImages !== expectedDecodedImages) {
    throw new Error(`Visual report decoded ${decodedImages} images; expected ${expectedDecodedImages}.`);
  }
  await page.screenshot({ path: preview, fullPage: false });
  const bytes = await fs.readFile(preview);
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error(`Invalid visual report preview PNG: ${preview}`);
  }
  manifest.reportPreview = {
    decodedImages,
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex')
  };
  const manifestTemporary = `${manifestPath}.preview.tmp`;
  await fs.writeFile(manifestTemporary, `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.rename(manifestTemporary, manifestPath);
  console.info(`Visual audit preview: ${preview}`);
} finally {
  await browser.close();
}
