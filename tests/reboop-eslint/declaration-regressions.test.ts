import { parser } from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

describe('redundant var declaration regressions', () => {
  /**
  A var without an initializer never replaces a binding's existing value.
  Additional bare declarations must preserve the one known initializer or
  parameter default, including body-environment parameter copies, TypeScript
  parameter properties, nested reads and Node namespace/dispatcher aliases.
  */
  it.each([
    ["function use(){var root=globalThis;var root;root.fetch('/items');}", 'module'],
    ["var root=globalThis;var root;root.fetch('/items');", 'module'],
    ["var root=globalThis;var root;root.fetch('/items');", 'script'],
    ["function use(root=globalThis){var root;root.fetch('/items');}", 'module'],
    ["function use(root=globalThis){var root;root.fetch('/items');}", 'script'],
    ["function use(root=globalThis){var root;return()=>root.fetch('/items');}", 'module'],
    ["function use(){var root=globalThis;var root;var root;root.fetch('/items');}", 'module'],
    ["function use(){var root;var root=globalThis;root.fetch('/items');}", 'module'],
    ["class Client{constructor(public root=globalThis){var root;root.fetch('/items');}}", 'module'],
    [
      "var root:typeof globalThis=globalThis;var root:typeof globalThis;root.fetch('/items');",
      'module',
    ],
    ["function use(){var root=require('node:http');var root;root.request('/items');}", 'commonjs'],
    [
      "import {Agent} from 'undici';var root=new Agent();var root;root.request('/items');",
      'module',
    ],
  ] as const)(
    'preserves one value origin across bare declarations: %s (%s)',
    async (code, sourceType) => {
      const result = await lint(code, 'src/client.ts', [
        { files: ['**/*.ts'], languageOptions: { parser, sourceType } },
      ]);
      expect(result.messages).toEqual([
        expect.objectContaining({ ruleId: 'reboop/require-client' }),
      ]);
    },
  );

  /**
  Bare declarations still introduce local shadows when no prior value is
  known. Multiple initializers, later writes and sloppy Annex B replacements
  invalidate an alias; function declarations supply local values rather than
  reviving a native global. These cases protect binding normalization from
  simply dropping every var declaration or blindly choosing the first value.
  */
  it.each([
    ["function use(){var window;var window;window.fetch('/items');}", 'module'],
    ["var window;var window;window.fetch('/items');", 'module'],
    ["var window;var window;window.fetch('/items');", 'commonjs'],
    ["function use(){var root=globalThis;var root=custom;root.fetch('/items');}", 'module'],
    ["function use(root=globalThis){var root=custom;root.fetch('/items');}", 'module'],
    ["var root=globalThis;var root;root=custom;root.fetch('/items');", 'module'],
    ["function use(){var window;function window(){}window.fetch('/items');}", 'script'],
    [
      "function use(){var root=globalThis;{function root(){}}var root;root.fetch('/items');}",
      'script',
    ],
    ["function use(window=custom){var window;window.fetch('/items');}", 'module'],
  ] as const)(
    'preserves real shadows and unknown replacements: %s (%s)',
    async (code, sourceType) => {
      const result = await lint(code, 'src/client.ts', [
        { files: ['**/*.ts'], languageOptions: { parser, sourceType } },
      ]);
      expect(result.messages).toEqual([]);
    },
  );
});
