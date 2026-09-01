import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireVisualAuditLock } from '../../scripts/visual-audit-lock.mjs';

const roots = [];

async function lockFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gppu-visual-lock-'));
  roots.push(root);
  return path.join(root, '.visual-audit.lock');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

it('rejects a concurrent visual audit while its owning process is alive', async () => {
  const lock = await lockFixture();
  const release = await acquireVisualAuditLock(lock, { processId: 101, isProcessAlive: () => true });
  await expect(acquireVisualAuditLock(lock, { processId: 202, isProcessAlive: () => true }))
    .rejects.toThrow('Visual audit already running under process 101');
  await release();
});

it('fails closed on a stale lock without deleting its ownership evidence', async () => {
  const lock = await lockFixture();
  await fs.mkdir(lock);
  await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ processId: 101, token: 'stale' }));
  await expect(acquireVisualAuditLock(lock, { processId: 202, isProcessAlive: () => false }))
    .rejects.toThrow('Stale visual audit lock from process 101');
  const owner = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8'));
  expect(owner).toEqual({ processId: 101, token: 'stale' });
});

it('allows a later visual audit after the first owner releases the lock', async () => {
  const lock = await lockFixture();
  const releaseFirst = await acquireVisualAuditLock(lock, { processId: 101 });
  await releaseFirst();
  const releaseSecond = await acquireVisualAuditLock(lock, { processId: 202 });
  await releaseSecond();
});

it('publishes a fully initialized owner atomically during concurrent acquisition', async () => {
  const lock = await lockFixture();
  let resumeFirst;
  let markFirstReady;
  const firstReady = new Promise((resolve) => { markFirstReady = resolve; });
  const firstPaused = new Promise((resolve) => { resumeFirst = resolve; });
  const firstAcquisition = acquireVisualAuditLock(lock, {
    processId: 101,
    isProcessAlive: () => true,
    beforePublish: async () => {
      markFirstReady();
      await firstPaused;
    }
  });
  await firstReady;
  const releaseSecond = await acquireVisualAuditLock(lock, { processId: 202, isProcessAlive: () => true });
  resumeFirst();
  await expect(firstAcquisition).rejects.toThrow('Visual audit already running under process 202');
  const owner = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8'));
  expect(owner.processId).toBe(202);
  await releaseSecond();
});
