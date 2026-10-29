import { parser } from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

describe('global var binding regressions', () => {
  /**
  A script-level var declaration without an initializer preserves an existing
  global property. Treating it as a fresh local binding would hide native
  fetch, XMLHttpRequest and their global-object aliases. Strict mode, repeated
  declarations, nested reads and block placement do not change that behavior.
  */
  it.each([
    "var fetch;fetch('/items');",
    "'use strict';var fetch;fetch('/items');",
    "var fetch;var fetch;fetch('/items');",
    "var fetch;function use(){fetch('/items');}use();",
    "if(enabled){var fetch;}fetch('/items');",
    'var XMLHttpRequest;new XMLHttpRequest();',
    "var window;window.fetch('/items');",
    "var globalThis;globalThis.fetch('/items');",
    "var self;self.fetch('/items');",
    "var global;global.fetch('/items');",
    "var window;var window;window['fetch']('/items');",
    "var window;const root=window;root.fetch('/items');",
  ])('preserves an existing native script binding: %s', async (code) => {
    const result = await lint(code, 'src/client.js', [
      { languageOptions: { sourceType: 'script' } },
    ]);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Configured globals and erased TypeScript declarations can share the var's
  scope metadata. They must not turn the preserved runtime value into an
  unknown local, including when its declaration carries a type annotation.
  */
  it.each([
    'var fetch:typeof globalThis.fetch;fetch("/items");',
    'var window;interface window{}window.fetch("/items");',
  ])('preserves native globals through typed var declarations: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      {
        files: ['**/*.ts'],
        languageOptions: {
          parser,
          sourceType: 'script',
          globals: { fetch: 'readonly', window: 'readonly' },
        },
      },
    ]);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  An initialized global var writes the existing native transport binding,
  just as a later assignment does. The acquisition policy rejects native
  reference modifications even when the replacement itself is a local client.
  */
  it.each([
    'var fetch=custom;',
    'var XMLHttpRequest=custom;',
    'var fetch;fetch=custom;',
    'var fetch;fetch||=custom;',
  ])('rejects writes to an existing native script binding: %s', async (code) => {
    const result = await lint(code, 'src/client.js', [
      { languageOptions: { sourceType: 'script' } },
    ]);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Module/CommonJS/function var bindings and lexical declarations genuinely
  shadow the native name. A custom initializer or later write also invalidates
  a global-object alias. These controls prevent a name-based fix from inventing
  transport references on local clients or unknown values. A bare declaration
  without a read or initializer does not acquire the existing native value.
  */
  it.each([
    ["var fetch;fetch('/items');", 'module'],
    ["var window;window.fetch('/items');", 'module'],
    ["var fetch;fetch('/items');", 'commonjs'],
    ["var window;window.fetch('/items');", 'commonjs'],
    ["function use(){var fetch;fetch('/items');}", 'script'],
    ["function use(){var window;window.fetch('/items');}", 'script'],
    ["let fetch;fetch('/items');", 'script'],
    ["let window;window.fetch('/items');", 'script'],
    ["const fetch=custom;fetch('/items');", 'script'],
    ["var window=custom;window.fetch('/items');", 'script'],
    ["var globalThis={fetch:custom};globalThis.fetch('/items');", 'script'],
    ["var window;window=custom;window.fetch('/items');", 'script'],
    ["var root;root.fetch('/items');", 'script'],
    ['var fetch;', 'script'],
  ] as const)('preserves actual local or unknown bindings: %s (%s)', async (code, sourceType) => {
    const result = await lint(code, 'src/client.js', [{ languageOptions: { sourceType } }]);
    expect(result.messages).toEqual([]);
  });
});
