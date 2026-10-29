import { parser } from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

describe('CommonJS wrapper binding regressions', () => {
  /**
  Node supplies require, module and exports as wrapper parameters. A bare
  top-level var redeclares that same binding without replacing its value.
  Both parsers must preserve loaders and public namespace forwarding, even
  through repeated declarations, local aliases, nested reads and new syntax.
  */
  it.each(
    [
      "var require;require('node:http').request('/items');",
      "var module;module.require('node:https').get('/items');",
      "var exports;exports.http=require('node:http');",
      "var require;new require('axios');",
      "var module;var module;const load=module.require;load('undici').fetch('/items');",
      "var exports;exports.http ||= require('node:http');",
      "var require;const load=require;load('node:http').request('/items');",
      "var require;function use(){require('node:http').request('/items');}",
      "var require;var module;var exports;exports.http=module.require('node:http');",
    ].flatMap((code) => ['js', 'ts'].map((extension) => ({ code, extension }))),
  )(
    'preserves native CommonJS wrapper bindings in $extension: $code',
    async ({ code, extension }) => {
      const result = await lint(code, `src/client.${extension}`, [
        {
          files: ['**/*.js', '**/*.ts'],
          languageOptions: { ...(extension === 'ts' && { parser }), sourceType: 'commonjs' },
        },
      ]);
      expect(result.messages).toEqual([
        expect.objectContaining({ ruleId: 'reboop/require-client' }),
      ]);
    },
  );

  /**
  Only the actual CommonJS wrapper owns these implicit parameters. Fresh
  function/module variables and parameters shadow them, and top-level fetch
  or window declarations remain ordinary CommonJS locals. Initializers and
  later writes invalidate the known loader rather than guess its replacement.
  */
  it.each(
    (
      [
        ["function use(){var require;require('node:http').request('/items');}", 'commonjs'],
        ["function use(){var module;module.require('node:http').request('/items');}", 'commonjs'],
        ["function use(){var exports;exports.http=require('node:http');}", 'commonjs'],
        ["function use(require){var require;require('node:http').request('/items');}", 'commonjs'],
        ["var require;require('node:http').request('/items');", 'module'],
        ["var module;module.require('node:http').request('/items');", 'module'],
        ["var exports;exports.http=require('node:http');", 'module'],
        ["var fetch;fetch('/items');", 'commonjs'],
        ["var window;window.fetch('/items');", 'commonjs'],
        ["var require=custom;require('node:http').request('/items');", 'commonjs'],
        ["var require;require=custom;require('node:http').request('/items');", 'commonjs'],
        ["var module=custom;module.require('node:http').request('/items');", 'commonjs'],
        ["var exports=custom;exports.http=require('node:http');", 'commonjs'],
      ] as const
    ).flatMap(([code, sourceType]) =>
      ['js', 'ts'].map((extension) => ({ code, sourceType, extension })),
    ),
  )(
    'keeps actual locals and unknown values in $extension ($sourceType): $code',
    async ({ code, extension, sourceType }) => {
      const result = await lint(code, `src/client.${extension}`, [
        {
          files: ['**/*.js', '**/*.ts'],
          languageOptions: {
            ...(extension === 'ts' && { parser }),
            sourceType,
          },
        },
      ]);
      expect(result.messages).toEqual([]);
    },
  );
});
