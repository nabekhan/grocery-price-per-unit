import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReleaseVerificationError, verifyRelease } from '../../scripts/verify-release.mjs';

async function write(root, relativePath, value) {
  const filename = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, value);
}

async function makeFixture({ version = '3.4.5', recorded = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gppu-userscript-release-'));
  const userscript = `// ==UserScript==\n// @version     ${version}\n// ==/UserScript==\n\nconsole.info('fixture');\n`;
  const userscriptSha256 = crypto.createHash('sha256').update(userscript).digest('hex');
  await Promise.all([
    write(root, 'package.json', JSON.stringify({ version })),
    write(root, 'package-lock.json', JSON.stringify({ version, packages: { '': { version } } })),
    write(root, 'dist/userscript/Grocery Price Per Unit.user.js', userscript),
    write(root, 'release-history.json', JSON.stringify({
      releases: recorded ? { [version]: { userscriptSha256 } } : {
        '3.4.4': { userscriptSha256: 'a'.repeat(64) }
      }
    }))
  ]);
  return { root, version, userscript, userscriptSha256 };
}

async function expectReleaseError(promise, fragments) {
  try {
    await promise;
    throw new Error('Expected release verification to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(ReleaseVerificationError);
    expect(error.errors).toEqual(expect.arrayContaining(fragments.map((fragment) => expect.stringContaining(fragment))));
  }
}

describe('userscript release identity', () => {
  it('verifies one recorded artifact and reports its immutable hash', async () => {
    const fixture = await makeFixture();
    await expect(verifyRelease(fixture.root)).resolves.toEqual({
      version: fixture.version,
      userscriptSha256: fixture.userscriptSha256,
      recorded: true
    });
  });

  it('accepts a strictly newer unrecorded candidate', async () => {
    const fixture = await makeFixture({ recorded: false });
    await expect(verifyRelease(fixture.root)).resolves.toMatchObject({
      version: '3.4.5',
      recorded: false
    });
  });

  it('rejects a strictly newer unrecorded version in release/install mode', async () => {
    const fixture = await makeFixture({ recorded: false });
    await expectReleaseError(verifyRelease(fixture.root, { requireRecorded: true }), [
      'version 3.4.5 is not recorded',
      'add its exact userscriptSha256 before release or installation'
    ]);
  });

  it('accepts exact recorded bytes in release/install mode', async () => {
    const fixture = await makeFixture();
    await expect(verifyRelease(fixture.root, { requireRecorded: true })).resolves.toMatchObject({
      version: fixture.version,
      userscriptSha256: fixture.userscriptSha256,
      recorded: true
    });
  });

  it('rejects changed bytes under an already-recorded version', async () => {
    const fixture = await makeFixture();
    await write(fixture.root, 'dist/userscript/Grocery Price Per Unit.user.js', `${fixture.userscript}\nchanged\n`);
    await expectReleaseError(verifyRelease(fixture.root), ['already recorded with SHA-256']);
  });

  it('requires package, lockfile, and userscript metadata versions to agree', async () => {
    const fixture = await makeFixture();
    await write(fixture.root, 'package-lock.json', JSON.stringify({
      version: '3.4.4', packages: { '': { version: '3.4.3' } }
    }));
    await write(fixture.root, 'dist/userscript/Grocery Price Per Unit.user.js', '// @version 3.4.2\n');
    await expectReleaseError(verifyRelease(fixture.root), [
      'package-lock.json: expected version 3.4.5',
      'packages[""]: expected version 3.4.5',
      '@version: expected version 3.4.5'
    ]);
  });

  it('rejects a candidate that does not advance every recorded release', async () => {
    const fixture = await makeFixture({ recorded: false });
    const history = { releases: {
      '3.4.4': { userscriptSha256: 'a'.repeat(64) },
      '3.5.0': { userscriptSha256: 'b'.repeat(64) }
    } };
    await write(fixture.root, 'release-history.json', JSON.stringify(history));
    await expectReleaseError(verifyRelease(fixture.root), ['new candidate 3.4.5 must be newer than recorded release 3.5.0']);
  });

  it.each([
    ['invalid version key', { not_semver: { userscriptSha256: 'a'.repeat(64) } }, 'invalid recorded semantic version'],
    ['non-object record', { '2.0.7': null }, 'release entry must be an object'],
    ['invalid digest', { '2.0.7': { userscriptSha256: 'a'.repeat(63) } }, 'invalid userscriptSha256'],
    ['legacy extension field', { '2.0.7': { userscriptSha256: 'a'.repeat(64), extensionTreeSha256: 'b'.repeat(64) } }, 'unexpected field extensionTreeSha256']
  ])('rejects a malformed userscript ledger: %s', async (_label, releases, fragment) => {
    const fixture = await makeFixture({ recorded: false });
    await write(fixture.root, 'release-history.json', JSON.stringify({ releases }));
    await expectReleaseError(verifyRelease(fixture.root), [fragment]);
  });

  it('optionally verifies the exact installed userscript bytes', async () => {
    const fixture = await makeFixture();
    const installed = path.join(fixture.root, 'installed.user.js');
    await write(fixture.root, 'installed.user.js', fixture.userscript);
    await expect(verifyRelease(fixture.root, { installedUserscriptPath: installed })).resolves.toMatchObject({
      installedUserscriptSha256: fixture.userscriptSha256
    });
  });

  it('rejects a changed or missing installed copy', async () => {
    const fixture = await makeFixture();
    const changed = path.join(fixture.root, 'changed.user.js');
    await write(fixture.root, 'changed.user.js', 'changed');
    await expectReleaseError(verifyRelease(fixture.root, { installedUserscriptPath: changed }), ['does not match generated artifact']);
    await expectReleaseError(verifyRelease(fixture.root, {
      installedUserscriptPath: path.join(fixture.root, 'missing.user.js')
    }), ['missing installed userscript']);
  });
});
