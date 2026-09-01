import { spawn } from 'node:child_process';
import path from 'node:path';
import { acquireVisualAuditLock } from './visual-audit-lock.mjs';

const root = process.cwd();
const lockDirectory = path.join(root, 'artifacts/screenshots/.visual-audit.lock');
const playwrightCli = path.join(root, 'node_modules/@playwright/test/cli.js');
const releaseLock = await acquireVisualAuditLock(lockDirectory);
let activeChild = null;
let interruptedBy = null;

const signalHandlers = new Map(['SIGHUP', 'SIGINT', 'SIGTERM'].map((signal) => [signal, () => {
  interruptedBy = signal;
  activeChild?.kill(signal);
}]));
for (const [signal, handler] of signalHandlers) process.on(signal, handler);

async function run(script, args = []) {
  if (interruptedBy) throw new Error(`Visual audit interrupted by ${interruptedBy}.`);
  await new Promise((resolve, reject) => {
    activeChild = spawn(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' });
    activeChild.once('error', reject);
    activeChild.once('exit', (code, signal) => {
      activeChild = null;
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(script)} failed${signal ? ` from ${signal}` : ` with exit ${code}`}.`));
    });
  });
}

try {
  await run('scripts/prepare-visual-audit.mjs');
  await run(playwrightCli, [
    'test',
    'tests/e2e/fixture.spec.js',
    'tests/e2e/userscript-fixture.spec.js',
    '--project=webkit',
    '--grep',
    'captures the visual state matrix from the built userscript artifact|lifts above broad bottom obstructions',
    '--workers=1'
  ]);
  await run('scripts/build-visual-report.mjs');
  await run('scripts/capture-visual-report.mjs');
} finally {
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  await releaseLock();
}
