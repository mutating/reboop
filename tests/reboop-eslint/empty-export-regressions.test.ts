import { parser } from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

describe('empty runtime reexport acquisition', () => {
  /**
  An empty runtime reexport still evaluates its source module, just like a
  side-effect import. Dedicated HTTP clients must keep that acquisition ban
  even with no specifiers to inspect. Check both parsers, package subpaths,
  conservative package normalization, escaped literals and empty-clause text.
  Existing side-effect imports and mixed type/value exports remain forbidden,
  so adding this path cannot accidentally replace those established checks.
  */
  it.each(
    [
      "export {} from 'node-fetch';",
      "export {} from 'cross-fetch';",
      "export {} from 'isomorphic-fetch';",
      "export {} from 'axios';",
      "export {} from 'ky';",
      "export {} from 'got';",
      "export {} from 'axios/dist/node/axios.cjs';",
      "export {} from 'ky/distribution/index.js';",
      "export {} from 'node-fetch/src/index.js';",
      "export {} from 'axios/../ky/index.js';",
      "export {} from 'got/../cross-fetch/index.js';",
      "export {} from 'ax\\u0069os';",
      "export { /* no bindings */ } from 'got';",
      "import 'axios';",
      "export {type Helper, default} from 'axios';",
    ].flatMap((code, caseIndex) =>
      (code.includes('type Helper') ? ['ts'] : ['js', 'ts']).map((extension) => ({
        code,
        caseIndex,
        extension,
      })),
    ),
  )(
    'rejects runtime source acquisition $caseIndex in $extension: $code',
    async ({ code, extension }) => {
      const result = await lint(code, `src/client.${extension}`, [
        {
          files: ['**/*.js', '**/*.ts'],
          languageOptions: { ...(extension === 'ts' && { parser }) },
        },
      ]);
      expect(result.messages).toEqual([
        expect.objectContaining({ ruleId: 'reboop/require-client' }),
      ]);
    },
  );

  /**
  Empty export clauses acquire no HTTP member from mixed helper modules.
  A local export has no source at all, and unknown package boundaries remain
  unknown rather than guessing a dedicated client from one path segment.
  These controls prevent replacing the missing check with a blanket ban.
  */
  it.each(
    [
      "export {} from 'node:http';",
      "export {} from 'https';",
      "export {} from 'undici';",
      "export {} from 'node:module';",
      "export {} from './client.js';",
      "export {} from 'local-client/../axios/index.js';",
      "export {} from 'axios/../local-client/index.js';",
      'export {};',
    ].flatMap((code, caseIndex) =>
      ['js', 'ts'].map((extension) => ({ code, caseIndex, extension })),
    ),
  )(
    'allows nontransport source acquisition $caseIndex in $extension: $code',
    async ({ code, extension }) => {
      const result = await lint(code, `src/client.${extension}`, [
        {
          files: ['**/*.js', '**/*.ts'],
          languageOptions: { ...(extension === 'ts' && { parser }) },
        },
      ]);
      expect(result.messages).toEqual([]);
    },
  );

  /**
  Explicit type exports remain erased by the rule's existing contract.
  In particular an empty export-type clause must not become a runtime load
  merely because its specifier list is empty, while all-type inline clauses
  retain the same treatment as other explicitly type-only reexports.
  */
  it.each([
    "export type {} from 'axios';",
    "export type {default} from 'axios';",
    "export {type Helper} from 'axios';",
    "export {type Helper, type Other} from 'ky';",
  ])('allows explicit type-only source clauses: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });
});
