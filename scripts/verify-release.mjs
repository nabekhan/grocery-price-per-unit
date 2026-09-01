import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * A release is one immutable userscript artifact. The ledger prevents changed
 * bytes from being published under a version that somebody may already have
 * installed, while --installed proves the app-managed copy is byte-identical.
 * Candidate verification deliberately permits a new, unrecorded version so
 * its digest can be reviewed. Release/install verification adds
 * --require-recorded and will not accept bytes missing from the ledger.
 */
const ARTIFACTS = {
  package: 'package.json',
  packageLock: 'package-lock.json',
  userscript: 'dist/userscript/Grocery Price Per Unit.user.js',
  history: 'release-history.json'
};
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export class ReleaseVerificationError extends Error {
  constructor(errors) {
    super(`Release identity verification failed with ${errors.length} error${errors.length === 1 ? '' : 's'}.`);
    this.name = 'ReleaseVerificationError';
    this.errors = errors;
  }
}

async function readText(root, relativePath, errors) {
  try {
    return await fs.readFile(path.join(root, relativePath), 'utf8');
  } catch (error) {
    errors.push(`${relativePath}: ${error.code === 'ENOENT' ? 'missing artifact' : error.message}`);
    return null;
  }
}

async function readJson(root, relativePath, errors) {
  const source = await readText(root, relativePath, errors);
  if (source === null) return null;
  try {
    return JSON.parse(source);
  } catch {
    errors.push(`${relativePath}: invalid JSON`);
    return null;
  }
}

function compareSemanticVersions(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function expectVersion(errors, artifact, actual, expected) {
  if (actual !== expected) errors.push(`${artifact}: expected version ${expected}, found ${actual ?? 'missing'}`);
}

export async function verifyRelease(root = process.cwd(), {
  installedUserscriptPath = null,
  requireRecorded = false
} = {}) {
  const errors = [];
  const [pkg, packageLock, userscript, history] = await Promise.all([
    readJson(root, ARTIFACTS.package, errors),
    readJson(root, ARTIFACTS.packageLock, errors),
    readText(root, ARTIFACTS.userscript, errors),
    readJson(root, ARTIFACTS.history, errors)
  ]);

  const version = pkg?.version;
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    errors.push(`${ARTIFACTS.package}: version must be a numeric major.minor.patch string`);
  } else {
    expectVersion(errors, ARTIFACTS.packageLock, packageLock?.version, version);
    expectVersion(errors, `${ARTIFACTS.packageLock} packages[""]`, packageLock?.packages?.['']?.version, version);
    const userscriptVersion = userscript?.match(/^\/\/\s*@version\s+(\S+)\s*$/m)?.[1];
    expectVersion(errors, `${ARTIFACTS.userscript} @version`, userscriptVersion, version);
  }

  const releaseMap = history?.releases && typeof history.releases === 'object' && !Array.isArray(history.releases)
    ? history.releases
    : null;
  if (!releaseMap) errors.push(`${ARTIFACTS.history}: releases must be an object`);
  if (releaseMap) {
    for (const [recordedVersion, release] of Object.entries(releaseMap)) {
      if (!VERSION_PATTERN.test(recordedVersion)) {
        errors.push(`${ARTIFACTS.history}: invalid recorded semantic version ${recordedVersion}`);
        continue;
      }
      if (!release || typeof release !== 'object' || Array.isArray(release)) {
        errors.push(`${ARTIFACTS.history}: ${recordedVersion} release entry must be an object`);
      } else {
        const unexpectedFields = Object.keys(release).filter((field) => field !== 'userscriptSha256');
        if (unexpectedFields.length) {
          errors.push(`${ARTIFACTS.history}: ${recordedVersion} has unexpected field${unexpectedFields.length === 1 ? '' : 's'} ${unexpectedFields.join(', ')}`);
        }
        if (!SHA256_PATTERN.test(release.userscriptSha256 ?? '')) {
          errors.push(`${ARTIFACTS.history}: ${recordedVersion} has an invalid userscriptSha256`);
        }
      }
    }
  }

  const userscriptSha256 = userscript === null
    ? null
    : crypto.createHash('sha256').update(userscript).digest('hex');
  const recorded = typeof version === 'string' ? releaseMap?.[version] : null;
  if (recorded) {
    if (recorded.userscriptSha256 !== userscriptSha256) {
      errors.push(`${ARTIFACTS.userscript}: version ${version} is already recorded with SHA-256 ${recorded.userscriptSha256}, current artifact is ${userscriptSha256}`);
    }
  } else if (VERSION_PATTERN.test(version || '') && releaseMap) {
    for (const recordedVersion of Object.keys(releaseMap)) {
      if (VERSION_PATTERN.test(recordedVersion) && compareSemanticVersions(version, recordedVersion) <= 0) {
        errors.push(`${ARTIFACTS.history}: new candidate ${version} must be newer than recorded release ${recordedVersion}`);
      }
    }
    if (requireRecorded) {
      errors.push(`${ARTIFACTS.history}: version ${version} is not recorded; add its exact userscriptSha256 before release or installation`);
    }
  }

  let installedUserscriptSha256 = null;
  if (installedUserscriptPath) {
    const absoluteInstalledPath = path.resolve(installedUserscriptPath);
    try {
      const installed = await fs.readFile(absoluteInstalledPath);
      installedUserscriptSha256 = crypto.createHash('sha256').update(installed).digest('hex');
      if (userscriptSha256 && installedUserscriptSha256 !== userscriptSha256) {
        errors.push(`${absoluteInstalledPath}: installed SHA-256 ${installedUserscriptSha256} does not match generated artifact ${userscriptSha256}`);
      }
    } catch (error) {
      errors.push(`${absoluteInstalledPath}: ${error.code === 'ENOENT' ? 'missing installed userscript' : error.message}`);
    }
  }

  if (errors.length) throw new ReleaseVerificationError(errors);
  return {
    version,
    userscriptSha256,
    recorded: Boolean(recorded),
    ...(installedUserscriptPath ? { installedUserscriptSha256 } : {})
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const knownArguments = new Set(['--installed', '--require-recorded']);
    for (let index = 2; index < process.argv.length; index += 1) {
      const argument = process.argv[index];
      if (!knownArguments.has(argument) && process.argv[index - 1] !== '--installed') {
        throw new ReleaseVerificationError([`unknown argument: ${argument}`]);
      }
    }
    const installedIndex = process.argv.indexOf('--installed');
    if (installedIndex >= 0 && (!process.argv[installedIndex + 1] || process.argv[installedIndex + 1].startsWith('--'))) {
      throw new ReleaseVerificationError(['--installed requires a userscript path']);
    }
    const installedUserscriptPath = installedIndex >= 0 ? process.argv[installedIndex + 1] : null;
    const requireRecorded = process.argv.includes('--require-recorded');
    const result = await verifyRelease(process.cwd(), { installedUserscriptPath, requireRecorded });
    console.info(`Userscript release identity verified: ${result.version}, SHA-256 ${result.userscriptSha256}${result.recorded ? ' [recorded]' : ' [new candidate]'}${installedUserscriptPath ? ' [installed copy matched]' : ''}.`);
  } catch (error) {
    if (error instanceof ReleaseVerificationError) {
      console.error(error.message);
      for (const detail of error.errors) console.error(`- ${detail}`);
      process.exitCode = 1;
    } else throw error;
  }
}
