import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function userscriptInstallerFixture({
  existing = true,
  failFinalVerification = false,
  failInitialRecordedVerification = false,
  replaceDestinationDuringFinalVerification = false,
  modifyDestinationDuringFinalVerification = false
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gppu-userscript-installer-'));
  const scripts = path.join(root, 'scripts');
  const binaryDirectory = path.join(root, 'bin');
  const destinationDirectory = path.join(root, 'Userscripts Folder');
  const destination = path.join(destinationDirectory, 'Grocery Price Per Unit.user.js');
  await Promise.all([
    fs.mkdir(scripts, { recursive: true }),
    fs.mkdir(binaryDirectory, { recursive: true }),
    fs.mkdir(path.join(root, 'dist/userscript'), { recursive: true }),
    fs.mkdir(destinationDirectory, { recursive: true })
  ]);
  await fs.copyFile('scripts/install-userscript.sh', path.join(scripts, 'install-userscript.sh'));
  await fs.chmod(path.join(scripts, 'install-userscript.sh'), 0o755);
  await fs.writeFile(path.join(root, 'dist/userscript/Grocery Price Per Unit.user.js'), 'new verified userscript\n');
  if (existing) await fs.writeFile(destination, 'previous userscript\n');
  await fs.writeFile(path.join(binaryDirectory, 'npm'), '#!/bin/sh\nexit 0\n');
  await fs.writeFile(path.join(binaryDirectory, 'node'), [
    '#!/bin/sh',
    failInitialRecordedVerification ? 'if [ "$2" = "--require-recorded" ] && [ "$#" -eq 2 ]; then exit 74; fi' : ':',
    'last=""',
    'for argument do last=$argument; done',
    failFinalVerification ? 'if [ "$last" = "$GPPU_TEST_DESTINATION" ]; then' : ':',
    failFinalVerification && replaceDestinationDuringFinalVerification
      ? '  printf "concurrent replacement\\n" > "$last.concurrent" && /bin/mv "$last.concurrent" "$last"'
      : failFinalVerification && modifyDestinationDuringFinalVerification
        ? '  printf "concurrent in-place update\\n" > "$last"'
      : ':',
    failFinalVerification ? '  exit 73\nfi' : ':',
    'exit 0'
  ].join('\n'));
  await Promise.all([
    fs.chmod(path.join(binaryDirectory, 'npm'), 0o755),
    fs.chmod(path.join(binaryDirectory, 'node'), 0o755)
  ]);
  return {
    root,
    destination: path.join(await fs.realpath(destinationDirectory), 'Grocery Price Per Unit.user.js'),
    binaryDirectory
  };
}

async function runUserscriptInstaller(fixture) {
  return execFileAsync(path.join(fixture.root, 'scripts/install-userscript.sh'), [fixture.destination], {
    env: {
      ...process.env,
      PATH: `${fixture.binaryDirectory}:${process.env.PATH}`,
      GPPU_TEST_DESTINATION: fixture.destination
    }
  });
}

it('verifies a temporary userscript before atomic replacement and preserves the previous file', async () => {
  const [pkg, installScript] = await Promise.all([
    fs.readFile('package.json', 'utf8').then(JSON.parse),
    fs.readFile('scripts/install-userscript.sh', 'utf8')
  ]);
  expect(pkg.scripts['userscript:verify']).toContain('verify-release.mjs');
  expect(pkg.scripts['userscript:verify']).toContain('--require-recorded');
  expect(pkg.scripts['userscript:candidate:verify']).not.toContain('--require-recorded');
  const temporaryVerification = installScript.indexOf('node scripts/verify-release.mjs --require-recorded --installed "$temporary_copy"');
  const backupMove = installScript.indexOf('/bin/mv -n "$destination" "$backup_path"');
  const replacement = installScript.indexOf('/bin/mv -n "$temporary_copy" "$destination"');
  expect(temporaryVerification).toBeGreaterThan(0);
  expect(temporaryVerification).toBeLessThan(replacement);
  expect(backupMove).toBeGreaterThan(temporaryVerification);
  expect(backupMove).toBeLessThan(replacement);
  expect(installScript).not.toContain('/bin/cp -p "$destination" "$backup_path"');
  expect(installScript).toContain('! /usr/bin/cmp -s "$destination" "$source_userscript"');
  expect(installScript).toContain("destination_basename=$(basename -- \"$destination\")");
  expect(installScript).toContain('pwd -P');
  expect(installScript).toContain("[ -L \"$destination\" ]");
  expect(installScript.indexOf("installed_identity=$(/usr/bin/stat -f '%d:%i' \"$destination\")")).toBeGreaterThan(replacement);
  expect(installScript.indexOf('node scripts/verify-release.mjs --require-recorded --installed "$destination"')).toBeGreaterThan(replacement);
});

it('rejects an unrecorded release before mutating the destination or creating a backup', async () => {
  const fixture = await userscriptInstallerFixture({ failInitialRecordedVerification: true });
  try {
    await expect(runUserscriptInstaller(fixture)).rejects.toMatchObject({ code: 74 });
    await expect(fs.readFile(fixture.destination, 'utf8')).resolves.toBe('previous userscript\n');
    const backups = (await fs.readdir(path.dirname(fixture.destination))).filter((entry) => entry.includes('.backup-'));
    expect(backups).toHaveLength(0);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

it('restores an existing userscript byte-for-byte when final verification fails', async () => {
  const fixture = await userscriptInstallerFixture({ failFinalVerification: true });
  try {
    await expect(runUserscriptInstaller(fixture)).rejects.toMatchObject({ code: 73 });
    await expect(fs.readFile(fixture.destination, 'utf8')).resolves.toBe('previous userscript\n');
    const backups = (await fs.readdir(path.dirname(fixture.destination))).filter((entry) => entry.includes('.backup-'));
    expect(backups).toHaveLength(1);
    await expect(fs.readFile(path.join(path.dirname(fixture.destination), backups[0]), 'utf8')).resolves.toBe('previous userscript\n');
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

it('removes an unverified first-install userscript when final verification fails', async () => {
  const fixture = await userscriptInstallerFixture({ existing: false, failFinalVerification: true });
  try {
    await expect(runUserscriptInstaller(fixture)).rejects.toMatchObject({ code: 73 });
    await expect(fs.stat(fixture.destination)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

it('does not overwrite a destination atomically replaced by another writer during verification', async () => {
  const fixture = await userscriptInstallerFixture({
    failFinalVerification: true,
    replaceDestinationDuringFinalVerification: true
  });
  try {
    await expect(runUserscriptInstaller(fixture)).rejects.toMatchObject({ code: 73 });
    await expect(fs.readFile(fixture.destination, 'utf8')).resolves.toBe('concurrent replacement\n');
    const backups = (await fs.readdir(path.dirname(fixture.destination))).filter((entry) => entry.includes('.backup-'));
    expect(backups).toHaveLength(1);
    await expect(fs.readFile(path.join(path.dirname(fixture.destination), backups[0]), 'utf8')).resolves.toBe('previous userscript\n');
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

it('does not overwrite an existing destination modified in place during final verification', async () => {
  const fixture = await userscriptInstallerFixture({
    failFinalVerification: true,
    modifyDestinationDuringFinalVerification: true
  });
  try {
    await expect(runUserscriptInstaller(fixture)).rejects.toMatchObject({ code: 73 });
    await expect(fs.readFile(fixture.destination, 'utf8')).resolves.toBe('concurrent in-place update\n');
    const backups = (await fs.readdir(path.dirname(fixture.destination))).filter((entry) => entry.includes('.backup-'));
    expect(backups).toHaveLength(1);
    await expect(fs.readFile(path.join(path.dirname(fixture.destination), backups[0]), 'utf8')).resolves.toBe('previous userscript\n');
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

it('does not remove a first-install destination modified in place during final verification', async () => {
  const fixture = await userscriptInstallerFixture({
    existing: false,
    failFinalVerification: true,
    modifyDestinationDuringFinalVerification: true
  });
  try {
    await expect(runUserscriptInstaller(fixture)).rejects.toMatchObject({ code: 73 });
    await expect(fs.readFile(fixture.destination, 'utf8')).resolves.toBe('concurrent in-place update\n');
    const backups = (await fs.readdir(path.dirname(fixture.destination))).filter((entry) => entry.includes('.backup-'));
    expect(backups).toHaveLength(0);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
