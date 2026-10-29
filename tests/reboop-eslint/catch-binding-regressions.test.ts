import { parser } from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

describe('catch binding initializer ownership', () => {
  /**
  A simple catch parameter receives a same-name var initializer, while the
  var declaration itself is hoisted outside the catch. That initializer does
  not replace an outer alias, parameter default, native script global or Node
  wrapper parameter. Treating it as an outer write would hide HTTP access.
  */
  it.each(
    (
      [
        [
          "var root=globalThis;try{throw custom}catch(root){var root=custom;}root.fetch('/items');",
          'module',
        ],
        [
          "function use(root=globalThis){try{throw custom}catch(root){var root=custom;}root.fetch('/items');}",
          'module',
        ],
        [
          "function use(){var root=globalThis;try{throw custom}catch(root){var root=custom;}return()=>root.fetch('/items');}",
          'module',
        ],
        [
          "var window;try{throw custom}catch(window){var window=custom;}window.fetch('/items');",
          'script',
        ],
        [
          "'use strict';var window;try{throw custom}catch(window){var window=custom;}window.fetch('/items');",
          'script',
        ],
        [
          "try{throw custom}catch(globalThis){var globalThis=custom;}globalThis.fetch('/items');",
          'script',
        ],
        [
          "var require;try{throw custom}catch(require){var require=custom;}require('node:http').request('/items');",
          'commonjs',
        ],
        [
          "var module;try{throw custom}catch(module){var module=custom;}module.require('node:https').get('/items');",
          'commonjs',
        ],
        [
          "var exports;try{throw custom}catch(exports){var exports=custom;}exports.client=require('node:http');",
          'commonjs',
        ],
        [
          "const {Agent}=require('undici');var root=new Agent();try{throw custom}catch(root){var root=custom;}root.request('/items');",
          'commonjs',
        ],
      ] as const
    ).flatMap(([code, sourceType], caseIndex) =>
      ['js', 'ts'].map((extension) => ({ code, sourceType, extension, caseIndex })),
    ),
  )(
    'preserves outer value $caseIndex in $extension ($sourceType): $code',
    async ({ code, sourceType, extension }) => {
      const result = await lint(code, `src/client.${extension}`, [
        {
          files: ['**/*.js', '**/*.ts'],
          languageOptions: { ...(extension === 'ts' && { parser }), sourceType },
        },
      ]);
      expect(result.messages).toEqual([
        expect.objectContaining({ ruleId: 'reboop/require-client' }),
      ]);
    },
  );

  /**
  Initializer ownership is not permission to discard every initializer or
  every var declaration. Fresh locals still shadow globals, actual outer
  writes invalidate known origins, a custom outer value stays custom, and
  dynamic with lookups cannot be proven to initialize another binding.
  Destructured catch parameters with a different name still permit a real
  outer write, while direct reads of the catch's own parameter remain local.
  */
  it.each(
    (
      [
        [
          "function use(){try{throw custom}catch(window){var window=custom;}window.fetch('/items');}",
          'module',
        ],
        ["try{throw custom}catch(window){var window=custom;}window.fetch('/items');", 'module'],
        [
          "var root=globalThis;try{throw custom}catch(other){var root=custom;}root.fetch('/items');",
          'module',
        ],
        [
          "var root=globalThis;try{throw custom}catch(root){var root=custom;}root=custom;root.fetch('/items');",
          'module',
        ],
        [
          "var root=custom;try{throw custom}catch(root){var root=globalThis;}root.fetch('/items');",
          'module',
        ],
        ["var root=globalThis;with(custom){var root=custom;}root.fetch('/items');", 'script'],
        [
          "var root=globalThis;try{throw custom}catch({value}){var root=custom;}root.fetch('/items');",
          'module',
        ],
        ["const root=globalThis;try{throw custom}catch(root){root.fetch('/items');}", 'module'],
        [
          "var require=custom;try{throw custom}catch(require){var require=another;}require('node:http').request('/items');",
          'commonjs',
        ],
      ] as const
    ).flatMap(([code, sourceType], caseIndex) =>
      ['js', 'ts'].map((extension) => ({ code, sourceType, extension, caseIndex })),
    ),
  )(
    'retains shadow or unknown write $caseIndex in $extension ($sourceType): $code',
    async ({ code, sourceType, extension }) => {
      const result = await lint(code, `src/client.${extension}`, [
        {
          files: ['**/*.js', '**/*.ts'],
          languageOptions: { ...(extension === 'ts' && { parser }), sourceType },
        },
      ]);
      expect(result.messages).toEqual([]);
    },
  );
});
