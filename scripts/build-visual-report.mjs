import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/* Build a human-readable gallery from one authoritative artifact: the exact
 * generated userscript. Semantic evidence lives beside each screenshot so a
 * polished but incorrect state cannot pass as visual proof. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const screenshotRoot = path.join(root, 'artifacts/screenshots');
const matrixSlug = 'userscript-control-state-matrix';
const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');
const stateKey = (state) => `${state.viewport.name}/${state.state}`;

async function pngInfo(filename) {
  const bytes = await fs.readFile(filename);
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error(`Invalid PNG screenshot: ${filename}`);
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
}

const matrixPath = path.join(screenshotRoot, matrixSlug, 'state-matrix.json');
const matrix = JSON.parse(await fs.readFile(matrixPath, 'utf8'));
if (!Array.isArray(matrix.states) || matrix.states.length === 0) {
  throw new Error(`No visual states found in ${matrixPath}`);
}
const keys = matrix.states.map(stateKey);
if (new Set(keys).size !== keys.length) throw new Error('Visual state matrix contains duplicate keys');

const pendingStates = matrix.states.filter((state) => state.dataState === 'pending');
const noMatchStates = matrix.states.filter((state) => state.dataState === 'no-match');
const settledStates = matrix.states.filter((state) => state.dataState === 'ready');
const controlStates = Object.fromEntries(await Promise.all(matrix.states.map(async (state) => {
  const filename = `${state.viewport.name}-${state.state}.png`;
  return [stateKey(state), {
    filename: `${matrixSlug}/${filename}`,
    ...await pngInfo(path.join(screenshotRoot, matrixSlug, filename))
  }];
})));

const forcedColorsEvidence = JSON.parse(await fs.readFile(
  path.join(screenshotRoot, matrixSlug, 'forced-colors.json'), 'utf8'
));
const forcedColorsImage = {
  filename: `${matrixSlug}/forced-colors-active-menu.png`,
  ...await pngInfo(path.join(screenshotRoot, matrixSlug, 'forced-colors-active-menu.png'))
};

const obstructionStates = [
  ...['phone-390', 'tablet-768', 'desktop-1440'].flatMap((viewport) => [
    'restored-lifted', 'active-lifted', 'menu-lifted', 'restored-resized-lifted', 'returned'
  ].map((state) => ({ viewport, state })))
];
const obstructionEvidence = Object.fromEntries(await Promise.all(obstructionStates.map(async ({ viewport, state }) => {
  const filename = `control-obstruction/${viewport}-${state}.png`;
  return [`${viewport}/${state}`, { filename, ...await pngInfo(path.join(screenshotRoot, filename)) }];
})));

const semanticFields = [
  'mode', 'restored', 'dataState', 'buttonText', 'statusText', 'announcementText',
  'optionValues', 'guideOpen', 'guideText', 'statusRoleCount', 'annotationCount',
  'annotationOutOfBoundsCount', 'inlineOrderCount', 'overflowCueVisible', 'menuScroll',
  'menuItemMinimumSize', 'clippedOptionTextCount', 'geometry', 'computedStyles'
];

const obstructionCards = obstructionStates.map(({ viewport, state }) => {
  const item = obstructionEvidence[`${viewport}/${state}`];
  return `<figure class="small-card">
    <figcaption><span>${escapeHtml(viewport)}</span><strong>${escapeHtml(state.replaceAll('-', ' '))}</strong></figcaption>
    <a href="${escapeHtml(item.filename)}"><img loading="lazy" src="${escapeHtml(item.filename)}" alt="${escapeHtml(`${viewport}: userscript control ${state} around a simulated bottom obstruction`)}"></a>
  </figure>`;
}).join('');

const stateCards = matrix.states.map((state) => {
  const key = stateKey(state);
  const image = controlStates[key];
  const pending = state.dataState === 'pending';
  const noMatch = state.dataState === 'no-match';
  const badge = pending
    ? '<span class="pending-badge">Current-page data pending</span>'
    : noMatch ? '<span class="no-match-badge">Accepted scope · no rendered match</span>' : '';
  const note = pending
    ? '<p class="state-note">Awaiting current-page product data — website order preserved.</p>'
    : noMatch
      ? '<p class="state-note no-match-note">The current response matches no rendered card — website order preserved.</p>'
      : '';
  const semantics = Object.fromEntries(semanticFields.map((field) => [field, state[field]]));
  return `<section class="state-card">
    <header><div><span class="viewport">${escapeHtml(state.viewport.name)}</span>${badge}<h2>${escapeHtml(state.state.replaceAll('-', ' '))}</h2></div>
    <dl><div><dt>Mode</dt><dd>${escapeHtml(state.mode)}</dd></div><div><dt>Cards</dt><dd>${state.annotationCount}</dd></div><div><dt>Control</dt><dd>${Math.round(state.geometry.control.width)}×${Math.round(state.geometry.control.height)}</dd></div></dl></header>
    ${note}
    <a class="hero-image" href="${escapeHtml(image.filename)}"><img loading="lazy" src="${escapeHtml(image.filename)}" alt="${escapeHtml(`Generated userscript: ${key}`)}"></a>
    <details><summary>Semantic evidence</summary><pre>${escapeHtml(JSON.stringify(semantics, null, 2))}</pre></details>
  </section>`;
}).join('');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Grocery Price Per Unit userscript visual audit</title>
<style>
  :root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17221d;background:#f3f6f4}*{box-sizing:border-box}body{max-width:1320px;margin:auto;padding:28px}h1{margin:0;font-size:30px;letter-spacing:-.03em}.lede,.surface-copy{max-width:850px;color:#566a60;line-height:1.5}.lede{margin:8px 0 24px}.legend{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:28px}.legend span,.viewport,.pending-badge,.no-match-badge,.small-card figcaption span{padding:4px 8px;border-radius:999px;background:#e2f1e7;color:#155f45;font-size:12px;font-weight:750}.pending-badge,.no-match-badge{margin-left:6px}.pending-badge{background:#fff1c7;color:#745500}.no-match-badge{background:#e8eefb;color:#274a7f}.surface-title{margin:34px 0 7px;font-size:24px}.small-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.small-card,.state-card{min-width:0;margin:0;padding:14px;border:1px solid #d7e1db;border-radius:16px;background:#fff;box-shadow:0 4px 18px #15251d0d}.small-card figcaption{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;text-transform:capitalize}.small-card a,.hero-image{display:block;overflow:auto;max-height:720px;border:1px solid #dfe6e1;border-radius:12px;background:#eef2ef}.small-card img,.hero-image img{display:block;width:100%;height:auto}.state-card{margin:0 0 24px;padding:18px}.state-card>header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:14px}.state-card h2{margin:7px 0 0;font-size:20px;text-transform:capitalize}.state-card dl{display:flex;gap:18px;margin:0}.state-card dl div{display:flex;gap:5px}.state-card dt{color:#65766d}.state-card dd{margin:0;font-weight:700}.state-note{margin:-4px 0 14px;padding:9px 11px;border-left:3px solid #d0a322;border-radius:0 8px 8px 0;background:#fff8df;color:#5e4a12;font-size:13px;font-weight:650}.no-match-note{border-left-color:#5279b7;background:#f1f5fc;color:#29456f}details{margin-top:13px}summary{cursor:pointer;color:#24684f;font-weight:700}pre{overflow:auto;padding:12px;border-radius:10px;background:#f5f7f5;font-size:12px;line-height:1.45}@media(max-width:900px){.small-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:650px){body{padding:14px}.small-grid{grid-template-columns:1fr}.state-card>header{align-items:flex-start;flex-direction:column}.state-card dl{flex-wrap:wrap}}
</style></head><body>
<h1>Grocery Price Per Unit userscript visual audit</h1>
<p class="lede">Post-layout screenshots from the exact generated userscript. The marketplace fixture stresses responsive geometry and truth states; it does not pretend to be a live-store screenshot.</p>
<div class="legend"><span>${matrix.states.length} control states: ${settledStates.length} ready/restored + ${pendingStates.length} pending + ${noMatchStates.length} no match</span><span>1 forced-colors state</span><span>${obstructionStates.length} obstruction states</span><span>${escapeHtml([...new Set(matrix.states.map((state) => state.viewport.name))].join(' · '))}</span><span>Semantic bounds enforced</span></div>
<h2 class="surface-title">Forced-colors accessibility</h2>
<p class="surface-copy">System-color rendering at 390 CSS pixels with visible selection, focus, 44 px targets, and non-color provenance patterns.</p>
<figure class="small-card"><a href="${escapeHtml(forcedColorsImage.filename)}"><img src="${escapeHtml(forcedColorsImage.filename)}" alt="Generated userscript in forced-colors mode"></a></figure>
<h2 class="surface-title">Bottom-obstruction placement</h2>
<p class="surface-copy">Phone, tablet, and desktop captures prove the panel lifts, resizes, opens its menu, and returns without altering the simulated page layer.</p>
<div class="small-grid">${obstructionCards}</div>
<h2 class="surface-title">In-page comparison control</h2>
<p class="surface-copy">Ready, restored, pending, and accepted-no-match states at four responsive breakpoints. Direction reversal remains in the arrow; the menu contains one clean row per comparison basis.</p>
${stateCards}
</body></html>`;

const reportPath = path.join(screenshotRoot, 'visual-audit-report.html');
const manifestPath = path.join(screenshotRoot, 'visual-audit-manifest.json');
const reportTemporary = `${reportPath}.tmp`;
const manifestTemporary = `${manifestPath}.tmp`;
await fs.writeFile(reportTemporary, html);
await fs.writeFile(manifestTemporary, `${JSON.stringify({
  version: 6,
  generatedAt: new Date().toISOString(),
  artifact: 'dist/userscript/Grocery Price Per Unit.user.js',
  semanticFields,
  stateSummary: {
    total: matrix.states.length,
    readyOrRestored: settledStates.length,
    pending: pendingStates.length,
    noMatch: noMatchStates.length
  },
  controlStates,
  accessibilityStates: {
    forcedColorsControl: { evidence: forcedColorsEvidence, images: [forcedColorsImage] }
  },
  obstructionStates: obstructionEvidence
}, null, 2)}\n`);
await fs.rename(reportTemporary, reportPath);
await fs.rename(manifestTemporary, manifestPath);
console.info(`Userscript visual audit report: ${reportPath}`);
