import { ESLint } from 'eslint';
import { defineConfig } from 'eslint/config';
import { parser } from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import plugin from '../../packages/reboop-eslint/src/index.js';
import { lint } from './lint.js';

describe('ESLint integration boundaries', () => {
  /**
  An embedding environment can impose strict mode through parser options
  without putting a directive in the source. Preserve that explicit context:
  the block function stays local to its block and the outer fetch is native.
  */
  it('honors an explicitly imposed strict parser context', async () => {
    const result = await lint("{function fetch(){}}fetch('/items');", 'src/client.js', [
      {
        languageOptions: {
          sourceType: 'script',
          parserOptions: { ecmaFeatures: { impliedStrict: true } },
        },
      },
    ]);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Logical assignments can return a known object when both possibilities
  agree. Coercing assignments return primitives even with those same known
  operands. Only the logical result acquires the native fetch reference.
  No later mutation of the global object is followed by these scenarios.
  */
  it.each([
    ['const result=(globalThis.globalThis ||= globalThis);console.log(typeof result.fetch);', 1],
    ['const result=(globalThis.globalThis += globalThis);console.log(typeof result.fetch);', 0],
  ] as const)('distinguishes assignment result kinds: %s', async (code, count) => {
    const result = await lint(code);
    expect(result.errorCount).toBe(count);
  });

  /**
  Coercing assignments return a primitive rather than their HTTP operand.
  Following their RHS as though it were a value-preserving assignment would
  fabricate a transport method or a public namespace export on the result.
  */
  it.each([
    "let slot=0;const result=(slot+=import('node:http'));console.log(typeof result.request);export default result;",
    "let slot='';const result=(slot+=require('node:http'));export default result;",
  ])('keeps coerced assignment results unknown: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });

  /**
  Annex B supplements a runtime block function even when a merged interface
  adds a type-only definition to the same variable. Requiring every definition
  to be a function would miss this local binding and invent native fetch.
  */
  it('retains Annex B functions merged with a type', async () => {
    const result = await lint(
      "if(true){function fetch(input:string){return input;}interface fetch{value:string;}}fetch('/items');",
      'src/client.ts',
      [{ files: ['**/*.ts'], languageOptions: { parser, sourceType: 'script' } }],
    );
    expect(result.messages).toEqual([]);
  });

  /**
  An erased namespace may need to traverse more than its immediate parent
  to reach a safe outer client. Returning the first missing lookup would
  instead fabricate a native global window and reject the local method.
  */
  it('finds a safe client beyond an intermediate namespace', async () => {
    const result = await lint(
      "const window={fetch(_url:string){}};namespace Outer{namespace Inner{namespace window{export type T=string;}window.fetch('/items');}}export{};",
      'src/client.ts',
      [{ files: ['**/*.ts'], languageOptions: { parser } }],
    );
    expect(result.messages).toEqual([]);
  });

  /**
  In a script the configured global and Annex B's function binding occupy
  the same outer scope. Predefined globals have no declarations and must not
  win before the local supplement, in role lookup or constant evaluation.
  */
  it.each([
    "{function fetch(){return 'local';}}fetch('/items');",
    "{function String(){return 'setTimeout';}}console.log(typeof globalThis[String('fetch')]);",
  ])('lets script Annex B bindings shadow configured globals: %s', async (code) => {
    const result = await lint(code, 'src/client.js', [
      {
        languageOptions: {
          sourceType: 'script',
          globals: { fetch: 'readonly', String: 'readonly' },
        },
      },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  The parser can accept a namespace export while the file is still awaiting
  semantic compiler validation. A declaration-less export must not crash
  origin analysis or prevent diagnostics in the surrounding application.
  This intentionally tests parser-accepted, semantically invalid TypeScript.
  */
  it('continues checking around an incomplete namespace export', async () => {
    const result = await lint(
      "namespace Local{export{};}console.log(typeof Local);fetch('/items');",
      'src/client.ts',
      [{ files: ['**/*.ts'], languageOptions: { parser } }],
    );
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  A type parameter can share one scope variable with an actual parameter or
  local value. Filtering only namespace/interface nodes leaves two runtime
  definitions and loses these native aliases; the parser's type-definition
  flag must keep the real value as the sole origin.
  */
  it.each([
    "function use<root>(root=globalThis):root|typeof globalThis{root.fetch('/items');return root;}",
    "function use<window>():window|typeof globalThis{const window=globalThis;window.fetch('/items');return window;}",
  ])('retains values merged with type parameters: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  A sequence can have more than two operands. Only its final function is
  passed to then; selecting index one happens to work for two operands but
  fabricates defaults or hides the HTTP argument in these three-part forms.
  */
  it.each([
    ["import('node:http').then((0,1,(root=globalThis)=>console.log(typeof root.fetch)));", 0],
    ["import('node:http').then((0,1,http=>http.request('/items')));", 1],
  ] as const)('follows the last callback in a longer sequence: %s', async (code, count) => {
    const result = await lint(code);
    expect(result.errorCount).toBe(count);
  });

  /**
  Erasing a namespace can reveal a safe outer value instead of a native
  global. Unconditionally accepting the erased symbol fabricates native
  window/require roles and incorrectly blocks these local clients.
  */
  it.each([
    "const window={fetch(_url:string){}};namespace N{export namespace window{export type T=string;}window.fetch('/items');}export{};",
    "const require=(name:string)=>({local:name});namespace N{export namespace require{export type T=string;}require('axios');}export{};",
  ])('retains safe outer values after namespace erasure: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  An ordinary function owns an implicit arguments object even though its
  scope variable has no declaration definitions. It must shadow an outer
  constant named arguments instead of turning that constant into a native
  transport key. An arrow captures the outer binding and remains protected.
  */
  it.each([
    ["const arguments='fetch';function use(){console.log(typeof globalThis[arguments]);}use();", 0],
    [
      "const arguments='fetch';const use=function(){console.log(typeof globalThis[arguments]);};use();",
      0,
    ],
    ["const arguments='fetch';const use=()=>console.log(typeof globalThis[arguments]);", 1],
  ] as const)('preserves implicit arguments bindings: %s', async (code, count) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.errorCount).toBe(count);
  });

  /**
  TypeScript emits namespace and enum bodies as ordinary function IIFEs with
  their own arguments objects, including when a type-only declaration uses
  the same name. These are valid non-strict scripts: compiler semantic checks
  report no errors, and running the emitted JS with a getter on fetch records
  zero reads. Looking through that emitted binding would invent the outer
  constant's fetch key; the nested namespace case also exercises outerValue.
  Babel and Rolldown emit the same function boundaries for these examples.
  */
  it.each([
    {
      name: 'namespace',
      code: "const arguments='fetch';namespace N{console.log(typeof globalThis[String(arguments) as 'fetch']);}",
    },
    {
      name: 'namespace with a same-name type alias',
      code: "const arguments='fetch';namespace N{type arguments=string;console.log(typeof globalThis[String(arguments) as 'fetch']);}",
    },
    {
      name: 'namespace with an arguments namespace',
      code: "const arguments='fetch';namespace N{namespace arguments{export type T=string;}console.log(typeof globalThis[String(arguments) as 'fetch']);}",
    },
    {
      name: 'enum initializer',
      code: "const arguments='fetch';enum E{V=(console.log(typeof globalThis[String(arguments) as 'fetch']),0)}",
    },
  ])('preserves emitted arguments in $name', async ({ code }) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser, sourceType: 'script' } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  Ordinary lexical blocks and arrows do not create arguments objects. Their
  emitted JS reads the fetch getter exactly once, so treating every scope as
  a function would hide real native access. A namespace's implicit arguments
  must also leave unrelated native window lookup protected. All three snippets
  passed TypeScript semantic checking; the module fixture's emitted JS was run
  with a window alias and an exports stub to observe the same single read.
  */
  it.each([
    {
      name: 'ordinary lexical block',
      code: "const arguments='fetch';{type arguments=string;console.log(typeof globalThis[String(arguments) as 'fetch']);}",
      sourceType: 'script',
    },
    {
      name: 'arrow with lexical arguments',
      code: "const arguments='fetch';const use=()=>console.log(typeof globalThis[String(arguments) as 'fetch']);use();",
      sourceType: 'script',
    },
    {
      name: 'native window beyond an erased namespace',
      code: "namespace N{namespace window{export type T=string;}window.fetch('/items');}export{};",
      sourceType: 'module',
    },
  ] as const)('retains native access through $name', async ({ code, sourceType }) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser, sourceType } },
    ]);
    expect(result.messages).toEqual([
      expect.objectContaining({ ruleId: 'reboop/require-client', severity: 2 }),
    ]);
  });

  /**
  An ordinary consumer taking a callback supplies no known module namespace.
  Bare identifier callees must keep local defaults local, while a default
  that acquires the native global remains prohibited. This also protects the
  unknown-callee path from assuming a member receiver or throwing.
  */
  it.each([
    ["consume((root={fetch(){}})=>root.fetch('/items'));", 0],
    ["consume((root=globalThis)=>root.fetch('/items'));", 1],
  ] as const)('respects callback defaults for an unknown consumer: %s', async (code, count) => {
    const result = await lint(code);
    expect(result.errorCount).toBe(count);
  });

  /**
  Consumers can register a plugin under their own namespace. Loading its
  recommended config through extends must retain that alias and expose useful
  editor metadata through ESLint, rather than depending on source-only tests.
  Public package/config names are stable labels for configuration inspection.
  */
  it('supports a consumer namespace and exposes registered metadata', async () => {
    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: defineConfig([
        { plugins: { policy: plugin }, extends: ['policy/recommended'] },
      ]),
    });
    const results = await eslint.lintText("fetch('/items');", { filePath: 'src/client.js' });
    expect(results[0]?.messages).toEqual([
      expect.objectContaining({ ruleId: 'policy/require-client', severity: 2 }),
    ]);
    expect(eslint.getRulesMetaForResults(results)).toMatchObject({
      'policy/require-client': {
        type: 'problem',
        docs: { description: 'Require HTTP requests through reboop' },
      },
    });
    const config: unknown = await eslint.calculateConfigForFile('src/client.js');
    expect(config).toHaveProperty('plugins.policy.meta.name', 'reboop-eslint');
    expect(plugin.configs.recommended.name).toBe('reboop/recommended');
  });

  /**
  Harmless callbacks, declarations and assignments must not be interpreted as
  imported-module arguments or public exports. These controls distinguish
  ordinary objects, rejected promises, later callback parameters and type-only
  namespace declarations from the corresponding protected transport cases.
  */
  it.each([
    "import('undici').then(()=>({fetch:localClient}));",
    "const use=(root)=>root.fetch('/items');",
    "import('undici').catch(({fetch})=>fetch('/items'));",
    "let request;import('node:http').then(()=>({request}={request(){}}));",
    "import('undici').then((unused,root={fetch(){}})=>root.fetch('/items'));",
    "const http=require('node:http');export namespace http {export type X=string;}",
    "namespace window {export type Marker=string;export const local=1;}window.fetch('/items');",
    'export let local;',
    "let target;const http=require('node:http');target=http;",
    "const object={};const http=require('node:http');object.value=http;",
    "import * as helper from './local-client.js';helper.fetch('/items');",
    "const local={};(await local).fetch('/items');",
    "const [{fetch:send}=window]=[{fetch:localClient}];send('/items');",
    "const pending=Promise.resolve({fetch:localClient});pending.then(({fetch})=>fetch('/items'));",
    "const a=import('./local-client.js'),b=import('node:module');const selected=flag?a:b;export const value=await selected;",
    "import * as http from 'node:http';import * as helper from 'node:module';const selected=flag?http:helper;console.log(typeof selected.request);",
  ])('allows independent local behavior: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  Different declaration or access forms must retain the same protected
  transport role. Mixed imports/exports exercise every binding independently;
  named callbacks, builtin constant evaluation and erased type parameters
  prevent protection from depending on one source spelling.
  */
  it.each([
    "import {type AxiosResponse,AxiosError} from 'axios';",
    "import http from 'node:http';export const server=http.createServer,native=http;",
    "namespace window {type Marker=string;}window.fetch('/items');",
    "namespace window {interface Marker {}}window.fetch('/items');",
    "function use<window>(){window.fetch('/items');}",
    "window[String('fetch')]('/items');",
    "const key='fetch';type key=string;function use(){window[key]('/items');}",
    "import('undici').then(function consume({fetch}){fetch('/items');});",
    "import {'default' as http} from 'node:http';http.request('/items');",
    "const root=globalThis?.globalThis;root.fetch('/items');",
    "import {Agent} from 'undici';new Agent().stream(options,factory);",
    "import {Agent} from 'undici';new Agent().pipeline(options,handler);",
    "import {Agent} from 'undici';new Agent().connect(options);",
    "namespace String {export type X=string;}const key=String.raw`fetch` as 'fetch';globalThis[key]('/items');",
  ])('retains protection across source variants: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.errorCount).toBe(1);
    expect(result.messages[0]?.ruleId).toBe('reboop/require-client');
  });

  /**
  A recursively referenced global type has no runtime binding, including in a
  script without a module scope. Type erasure must terminate at the global
  boundary and still leave the native window reference detectable.
  */
  it('handles recursive global types in script mode', async () => {
    const result = await lint(
      'interface window {child?:window} window.fetch("/items");',
      'src/client.ts',
      [{ files: ['**/*.ts'], languageOptions: { parser, sourceType: 'script' } }],
    );
    expect(result.errorCount).toBe(1);
  });
});
