import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gt, valid } from 'semver';

const npmCli = process.env['npm_execpath'];
if (npmCli === undefined || !path.isAbsolute(npmCli)) {
  throw new Error('Run this script through npm run release:publish.');
}

const version = process.env['RELEASE_VERSION'];
if (version === undefined || !/^0\.1\.[1-9]\d*$/u.test(version)) {
  throw new Error('RELEASE_VERSION must be 0.1.<GitHub Actions run number>.');
}

const packageNames = ['reboop', 'reboop-eslint'];
const npmExecutable: string = npmCli;

function latestVersion(packageName: string): string | undefined {
  const result = spawnSync(
    process.execPath,
    [npmExecutable, 'view', packageName, 'dist-tags', '--json'],
    { encoding: 'utf8' },
  );
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Cannot inspect distribution tags for ${packageName}: ${result.stderr}`);
  }
  // npm view returns no output when the first publication has no latest tag yet.
  if (result.stdout.trim() === '') {
    return undefined;
  }
  const tags: unknown = JSON.parse(result.stdout);
  if (typeof tags !== 'object' || tags === null || Array.isArray(tags)) {
    throw new TypeError(`Invalid distribution tags for ${packageName}.`);
  }
  const latest: unknown = Reflect.get(tags, 'latest');
  if (latest === undefined) {
    return undefined;
  }
  if (typeof latest !== 'string' || valid(latest) === null) {
    throw new TypeError(`Invalid latest version for ${packageName}.`);
  }
  return latest;
}

for (const packageName of packageNames) {
  const archive = path.resolve(`artifacts/${packageName}-${version}.tgz`);
  const integrity = `sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`;
  const lookup = spawnSync(
    process.execPath,
    [npmCli, 'view', `${packageName}@${version}`, 'dist.integrity', '--json'],
    { encoding: 'utf8' },
  );
  if (lookup.error !== undefined) {
    throw lookup.error;
  }
  if (lookup.status === 0) {
    const publishedIntegrity: unknown = JSON.parse(lookup.stdout);
    if (publishedIntegrity !== integrity) {
      throw new Error(
        `${packageName}@${version} exists with different contents; refusing to replace it.`,
      );
    }
    console.info(`${packageName}@${version} is already published with identical contents.`);
  } else if (lookup.stdout.includes('E404') || lookup.stderr.includes('E404')) {
    execFileSync(
      process.execPath,
      [
        npmExecutable,
        'publish',
        archive,
        '--access',
        'public',
        '--tag',
        `release-${version}`,
        '--provenance',
      ],
      {
        stdio: 'inherit',
      },
    );
  } else {
    throw new Error(`Cannot inspect ${packageName}@${version}: ${lookup.stderr}`);
  }
}

// Both immutable versions must exist before either public latest tag advances.
let isLatest = true;
for (const packageName of packageNames) {
  const latest = latestVersion(packageName);
  if (latest === undefined || gt(version, latest)) {
    execFileSync(
      process.execPath,
      [npmExecutable, 'dist-tag', 'add', `${packageName}@${version}`, 'latest'],
      { stdio: 'inherit' },
    );
  } else if (gt(latest, version)) {
    isLatest = false;
  }
}

const githubOutput = process.env['GITHUB_OUTPUT'];
if (githubOutput !== undefined) {
  appendFileSync(githubOutput, `latest=${String(isLatest)}\n`);
}
