import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function defaultProcessAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export async function acquireVisualAuditLock(lockDirectory, {
  processId = process.pid,
  isProcessAlive = defaultProcessAlive,
  beforePublish = null
} = {}) {
  const token = crypto.randomUUID();
  const ownerPath = path.join(lockDirectory, 'owner.json');
  await fs.mkdir(path.dirname(lockDirectory), { recursive: true });

  for (;;) {
    const candidateDirectory = `${lockDirectory}.candidate-${crypto.randomUUID()}`;
    try {
      await fs.mkdir(candidateDirectory);
      await fs.writeFile(
        path.join(candidateDirectory, 'owner.json'),
        `${JSON.stringify({ processId, token, startedAt: new Date().toISOString() })}\n`,
        { flag: 'wx' }
      );
      await beforePublish?.();
      await fs.rename(candidateDirectory, lockDirectory);
      break;
    } catch (error) {
      await fs.rm(candidateDirectory, { recursive: true, force: true });
      if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
      let owner = null;
      try { owner = JSON.parse(await fs.readFile(ownerPath, 'utf8')); } catch { /* handled as stale */ }
      if (Number.isSafeInteger(owner?.processId) && owner.processId > 0 && isProcessAlive(owner.processId)) {
        throw new Error(`Visual audit already running under process ${owner.processId}.`);
      }
      throw new Error(`Stale visual audit lock${owner?.processId ? ` from process ${owner.processId}` : ''}: ${lockDirectory}. Remove that exact lock directory after confirming no audit is running.`);
    }
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    let owner = null;
    try { owner = JSON.parse(await fs.readFile(ownerPath, 'utf8')); } catch { /* fail closed below */ }
    if (owner?.token !== token) throw new Error('Visual audit lock ownership changed before release.');
    await fs.rm(lockDirectory, { recursive: true });
  };
}
