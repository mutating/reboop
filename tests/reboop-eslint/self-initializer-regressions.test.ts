import { parser } from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

describe('same-binding var initializer regressions', () => {
  /**
  A var initializer that reads the very same binding and writes its value back
  does not replace an existing global or CommonJS wrapper parameter. Preserve
  native global objects, loaders and public exports rather than treating that
  identity initialization as an uninitialized recursive local variable.
  */
  it.each(
    (
      [
        ['var globalThis=globalThis;consume(globalThis.fetch);', 'script'],
        ['var window=window;consume(window.fetch);', 'script'],
        ['var self=self;consume(self.XMLHttpRequest);', 'script'],
        ['var global=global;consume(global.fetch);', 'script'],
        ["var require=require;consume(require('node:http').request);", 'commonjs'],
        ["var module=module;consume(module.require('node:https').get);", 'commonjs'],
        ["var exports=exports;exports.api=require('node:http');", 'commonjs'],
        ["var module=module;module.exports=require('node:http');", 'commonjs'],
        ["var require=require;new require('axios');", 'commonjs'],
      ] as const
    ).flatMap(([code, sourceType], caseIndex) =>
      ['js', 'ts-parser'].map((parserName) => ({ code, sourceType, caseIndex, parserName })),
    ),
  )(
    'preserves the existing implicit value in case $caseIndex ($parserName)',
    async ({ code, sourceType, parserName }) => {
      const result = await lint(code, 'src/client.js', [
        {
          languageOptions: { ...(parserName === 'ts-parser' && { parser }), sourceType },
        },
      ]);
      expect(result.messages).toEqual([
        expect.objectContaining({ ruleId: 'reboop/require-client' }),
      ]);
    },
  );

  /**
  Repeating a same-binding var initializer also preserves a known explicit
  initializer or parameter default. The no-op can precede the real initializer,
  sit inside a nested block, or capture the body environment's parameter copy.
  Parentheses keep the same identifier expression and introduce no evaluation.
  Property/module-name constants must also retain their effective-constant write
  metadata when the string evaluator reads the normalized variable view.
  */
  it.each(
    [
      'var root=globalThis;var root=root;consume(root.fetch);',
      'var root=root;var root=globalThis;consume(root.fetch);',
      'var root=globalThis;var root=(root);consume(root.XMLHttpRequest);',
      'var root=globalThis;{var root=root;}consume(root.fetch);',
      'function use(root=globalThis){var root=root;consume(root.fetch);}',
      'const use=function inner(root=globalThis){var root=root;consume(root.fetch);};',
      'const use=(root=globalThis)=>{var root=root;consume(root.fetch);};',
      "var propertyName='fetch';var propertyName=propertyName;consume(globalThis[propertyName]);",
      "var propertyName='XMLHttpRequest';var propertyName=propertyName;const{[propertyName]:Request}=globalThis;consume(Request);",
      "var moduleName='axios';var moduleName=moduleName;require(moduleName);",
      "var moduleName='node:http';var moduleName=moduleName;consume(require(moduleName).request);",
    ].flatMap((code, caseIndex) =>
      ['js', 'ts-parser'].map((parserName) => ({ code, caseIndex, parserName })),
    ),
  )(
    'retains one explicit value origin in case $caseIndex ($parserName)',
    async ({ code, parserName }) => {
      const result = await lint(code, 'src/client.js', [
        { languageOptions: { ...(parserName === 'ts-parser' && { parser }) } },
      ]);
      expect(result.messages).toEqual([
        expect.objectContaining({ ruleId: 'reboop/require-client' }),
      ]);
    },
  );

  /**
  TypeScript's erased expression wrappers do not change identifier identity.
  Type-only shadows must resolve to the surviving value binding, and a
  constructor parameter property has the same body-copy semantics as a plain
  parameter. Explicit any annotations avoid unrelated redeclaration-type errors
  while leaving the runtime initializer graph unchanged.
  */
  it.each(
    [
      'var root:any=globalThis;var root:any=root as any;consume(root.fetch);',
      'var root:any=globalThis;var root:any=(root satisfies typeof globalThis);consume(root.fetch);',
      'var root:any=globalThis;var root:any=root!;consume(root.fetch);',
      'var root:any=globalThis;var root:any=<any>root;consume(root.fetch);',
      'var root:any=globalThis;{type root=number;var root:any=root;}consume(root.fetch);',
      'var root:any=globalThis;{interface root{}var root:any=root;}consume(root.fetch);',
      'class C{constructor(public root:any=globalThis){var root:any=root;consume(root.fetch);}}',
      "import{createRequire}from'node:module';const require=createRequire('/app/client.cjs');var load:(<T>(id:string)=>any)=require;var load:(<T>(id:string)=>any)=load<unknown>;load('axios');",
    ].map((code, caseIndex) => ({
      code: 'export{};declare function consume(value:unknown):void;' + code,
      caseIndex,
    })),
  )('recognizes erased identity wrappers in case $caseIndex', async ({ code }) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Identity initialization preserves a value; it cannot create one. Fresh local
  vars, unknown parameters and sources, lexical TDZ bindings, competing real
  initializers and later writes stay unknown. Destructuring changes a binding's
  value rather than copying it back, and its recursive defaults must terminate.
  Member access and sequence expressions are not transparent identifier casts.
  Iteration writes and real string-name changes must remain in the normalized
  reference view so constant property/module evaluation cannot ignore them.
  These are valid JavaScript sources; the TDZ/cycle cases intentionally do not
  claim successful execution or TypeScript's separate type-checking acceptance.
  */
  it.each(
    (
      [
        ['function use(){var window=window;consume(window.fetch);}', 'module'],
        ["function use(){var require=require;require('axios');}", 'commonjs'],
        ['function use(window){var window=window;consume(window.fetch);}', 'module'],
        ['let window=window;consume(window.fetch);', 'script'],
        ['const window=window;consume(window.fetch);', 'script'],
        ["var root=require('node:http');var {default:root}=root;consume(root?.request);", 'module'],
        ["var {default:root=root}=require('node:http');consume(root.request);", 'module'],
        ['var root=custom;var root=root;consume(root.fetch);', 'module'],
        ['var root=globalThis;var root=root;var root=custom;consume(root.fetch);', 'module'],
        ['var root=globalThis;var root=root;root=custom;consume(root.fetch);', 'module'],
        ['var root=globalThis;var root=custom.root;consume(root.fetch);', 'module'],
        ['var root=globalThis;var root=(effect(),root);consume(root.fetch);', 'module'],
        ['var root=globalThis;with(custom){var root=root;}consume(root.fetch);', 'script'],
        [
          'function use(){try{throw custom;}catch(window){var window=window;}consume(window.fetch);}',
          'script',
        ],
        [
          'var root=custom;try{throw custom;}catch(root){var root=root;}consume(root.fetch);',
          'module',
        ],
        ['var root=globalThis;function use(root){var root=root;consume(root.fetch);}', 'module'],
        ['var window=custom;var window=window;consume(window.fetch);', 'script'],
        ["var require=custom;var require=require;require('axios');", 'commonjs'],
        [
          "var propertyName='fetch';var propertyName=propertyName;for(var propertyName in propertyName){}consume(globalThis[propertyName]);",
          'module',
        ],
        [
          "var propertyName='fetch';var propertyName=propertyName;for(var propertyName of propertyName){}consume(globalThis[propertyName]);",
          'module',
        ],
        [
          "var moduleName='axios';var moduleName=moduleName;moduleName='local-client';require(moduleName);",
          'module',
        ],
        [
          "var propertyName='fetch';var propertyName=propertyName;var propertyName='setTimeout';consume(globalThis[propertyName]);",
          'module',
        ],
      ] as const
    ).flatMap(([code, sourceType], caseIndex) =>
      ['js', 'ts-parser'].map((parserName) => ({ code, sourceType, caseIndex, parserName })),
    ),
  )(
    'keeps unknown or value-changing initialization in case $caseIndex ($parserName)',
    async ({ code, sourceType, parserName }) => {
      const result = await lint(code, 'src/client.js', [
        {
          languageOptions: { ...(parserName === 'ts-parser' && { parser }), sourceType },
        },
      ]);
      expect(result.messages).toEqual([]);
    },
  );
});
