import path from 'node:path';
import { ESLint } from 'eslint';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Platform = 'win32' | 'posix';

async function lintOnPlatform(platform: Platform, code: string): Promise<ESLint.LintResult> {
  const backend = platform === 'win32' ? path.win32 : path.posix;
  vi.resetModules();
  vi.doMock('node:path', (): { default: typeof path.win32 } => ({ default: backend }));
  const { default: plugin } = await import('../../packages/reboop-eslint/src/index.js');
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [plugin.configs.recommended, { languageOptions: { sourceType: 'commonjs' } }],
  });
  const [result] = await eslint.lintText(code, { filePath: 'src/client.cjs' });
  if (result === undefined) {
    throw new Error('Expected ESLint to process the source');
  }
  expect(result.fatalErrorCount).toBe(0);
  expect(result.warningCount).toBe(0);
  return result;
}

afterEach(() => {
  vi.doUnmock('node:path');
  vi.resetModules();
});

const windowsSubpaths = [
  'node-fetch\\src\\index.js',
  'cross-fetch\\dist\\node-ponyfill.js',
  'isomorphic-fetch\\fetch-npm-node.js',
  'axios\\dist\\node\\axios.cjs',
  'ky\\distribution\\index.js',
  'got\\dist\\source\\index.js',
];

const loaderForms = [
  (specifier: string): string => `require(${JSON.stringify(specifier)});`,
  (specifier: string): string => `new require(${JSON.stringify(specifier)});`,
  (specifier: string): string => `module['require']?.(${JSON.stringify(specifier)});`,
  (specifier: string): string =>
    `const {createRequire}=require('node:module');const load=createRequire(${JSON.stringify('C:\\app\\client.cjs')});load(${JSON.stringify(specifier)});`,
];

describe('platform-specific package path acquisition', () => {
  /**
  Windows CommonJS resolves backslashes as directory separators before its
  legacy file lookup. Dedicated clients remain forbidden under every known
  loader form, including side-effect loads and constructed require. Mocking
  only the plugin's path backend exercises Windows classification without
  changing ESLint's own filesystem paths or requiring a Windows runner.
  */
  it.each(
    windowsSubpaths.flatMap((specifier, pathIndex) =>
      loaderForms.map((source, loaderIndex) => ({
        code: source(specifier),
        pathIndex,
        loaderIndex,
      })),
    ),
  )('rejects Windows package subpath $pathIndex through loader $loaderIndex', async ({ code }) => {
    const result = await lintOnPlatform('win32', code);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Forward and backward separators may coexist on Windows, including package
  boundary normalization. Both the original and normalized package roots
  must retain the existing dedicated-client check rather than losing the
  first root at a backslash or disabling normalization after replacing it.
  */
  it.each([
    'axios\\dist/node\\axios.cjs',
    'node-fetch/src\\index.js',
    'axios\\..\\ky\\distribution\\index.js',
    'got\\..\\cross-fetch/dist/node-ponyfill.js',
  ])('rejects mixed and normalized Windows subpaths: %s', async (specifier) => {
    const result = await lintOnPlatform('win32', `require(${JSON.stringify(specifier)});`);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  On POSIX a backslash in the first package component is an ordinary filename
  character, not a directory separator. Replacing every backslash on every
  host would invent a dedicated package and reject unknown local packages.
  The same Windows-looking source must therefore stay unknown on POSIX.
  */
  it.each([
    ...windowsSubpaths,
    'axios\\dist/node\\axios.cjs',
    'local-client\\axios/index.js',
    'axios\\..\\ky\\distribution\\index.js',
  ])('preserves POSIX package names containing backslashes: %s', async (specifier) => {
    const result = await lintOnPlatform('posix', `require(${JSON.stringify(specifier)});`);
    expect(result.messages).toEqual([]);
  });

  /**
  Standard slash-based package requests retain their existing detection on
  both hosts. These controls distinguish host-aware separator support from
  a Windows-only rule or a blanket exemption for ordinary package names.
  */
  it.each(
    windowsSubpaths.flatMap((specifier, caseIndex) =>
      (['win32', 'posix'] as const).map((platform) => ({
        platform,
        specifier: specifier.replaceAll('\\', '/'),
        caseIndex,
      })),
    ),
  )(
    'retains standard package paths on $platform in case $caseIndex',
    async ({ platform, specifier }) => {
      const result = await lintOnPlatform(platform, `require(${JSON.stringify(specifier)});`);
      expect(result.messages).toEqual([
        expect.objectContaining({ ruleId: 'reboop/require-client' }),
      ]);
    },
  );

  /**
  An unknown package at either boundary remains unknown under the documented
  conservative policy. Native helper modules also stay legal until a transport
  member is acquired. New separator handling must not guess origins from an
  incidental axios segment or reject every CommonJS load on Windows.
  */
  it.each(
    [
      'local-client\\..\\axios\\index.js',
      'axios\\..\\local-client\\index.js',
      'local-client/../axios/index.js',
      'axios/../local-client/index.js',
      'local-client\\axios/index.js',
      'node:http',
      'node:module',
    ].flatMap((specifier, caseIndex) =>
      (['win32', 'posix'] as const).map((platform) => ({ platform, specifier, caseIndex })),
    ),
  )(
    'retains unknown packages and helpers on $platform in case $caseIndex',
    async ({ platform, specifier }) => {
      const result = await lintOnPlatform(platform, `require(${JSON.stringify(specifier)});`);
      expect(result.messages).toEqual([]);
    },
  );
});
