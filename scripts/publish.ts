import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const npmCli = process.env['npm_execpath'];
if (npmCli === undefined || !path.isAbsolute(npmCli)) {
  throw new Error('Run this script through npm run release:publish.');
}

const version = process.env['RELEASE_VERSION'];
if (version === undefined || !/^0\.1\.[1-9]\d*$/u.test(version)) {
  throw new Error('RELEASE_VERSION must be 0.1.<GitHub Actions run number>.');
}

for (const packageName of ['reboop', 'reboop-eslint']) {
  const archive = `artifacts/${packageName}-${version}.tgz`;
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
      [npmCli, 'publish', archive, '--access', 'public', '--provenance'],
      {
        stdio: 'inherit',
      },
    );
  } else {
    throw new Error(`Cannot inspect ${packageName}@${version}: ${lookup.stderr}`);
  }
}
