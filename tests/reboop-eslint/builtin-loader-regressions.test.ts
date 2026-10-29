import { parser } from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

describe('Node built-in loader integration regressions', () => {
  /**
  process.getBuiltinModule returns the actual built-in namespace, including when
  detached, selected by a static key, or invoked with new. These cases protect
  native globals, immutable loader aliases, and namespace destructuring from
  silently bypassing transport acquisition checks. Executing the probes in Node
  confirmed native method identity without sending requests.
  */
  it.each([
    "process.getBuiltinModule('http').request;",
    "globalThis.process.getBuiltinModule('node:https').get;",
    "global.process.getBuiltinModule('node:http').ClientRequest;",
    "const p=process;const key='getBuiltinModule';const load=p[key];load('http').get;",
    "const {getBuiltinModule:load}=process;const {request}=load('node:http');",
    "new (process.getBuiltinModule)('http').request;",
  ])('detects a global built-in loader: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  The process module exposes the same loader through CommonJS, default, named,
  namespace and dynamic imports. A namespace's default is the raw module, while
  an inline Promise callback receives the namespace. Every route must preserve
  the built-in-only loader identity rather than becoming an unknown helper.
  */
  it.each([
    "require('process').getBuiltinModule('http').request;",
    "const {getBuiltinModule:load}=require('node:process');load('https').get;",
    "import p from'process';p.getBuiltinModule('http').request;",
    "import*as p from'node:process';p.getBuiltinModule('https').request;",
    "import{getBuiltinModule as load}from'process';load('node:http').get;",
    "import*as p from'node:process';p.default.getBuiltinModule('http').request;",
    "const p=await import('process');p.getBuiltinModule('http').request;",
    "import('node:process').then(({getBuiltinModule:load})=>load('http').request);",
    "import('process').then(({default:{getBuiltinModule:load}})=>load('https').get);",
  ])('detects an imported built-in loader: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Built-ins can supply process itself or the module factory, and an obtained
  HTTP namespace can be forwarded publicly. These cases prevent a fix limited
  to immediate .request syntax: existing origin tracking must also handle
  chained loaders, createRequire, ESM exports and CommonJS namespace exports.
  */
  it.each([
    "process.getBuiltinModule('process').getBuiltinModule('https').get;",
    "process.getBuiltinModule('node:process').getBuiltinModule('node:http').request;",
    "const {createRequire}=process.getBuiltinModule('module');const load=createRequire('/tmp/client.cjs');load('http').request;",
    "const {createRequire}=process.getBuiltinModule('node:module');const load=createRequire('/tmp/client.cjs');load('node:https').get;",
    "export default process.getBuiltinModule('http');",
    "export const native=process.getBuiltinModule('https');",
    "module.exports=process.getBuiltinModule('node:http');",
  ])('retains namespace and factory origins: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  getBuiltinModule does not load npm packages or normalize arbitrary paths.
  Reusing the unrestricted require loader would falsely diagnose these calls.
  Native Node execution confirmed undefined for all ordinary calls here; new
  with a non-built-in instead produces an ordinary instance without transports.
  */
  it.each([
    "process.getBuiltinModule('axios')?.request;",
    "process.getBuiltinModule('undici')?.fetch;",
    "process.getBuiltinModule('node-fetch');",
    "process.getBuiltinModule('node:axios')?.request;",
    "process.getBuiltinModule('node:undici')?.fetch;",
    "process.getBuiltinModule('axios/lib/client.js');",
    "process.getBuiltinModule('HTTP')?.request;",
    "process.getBuiltinModule('http/')?.request;",
    "new (process.getBuiltinModule)('axios').request;",
  ])('does not treat a non-built-in as a loaded transport: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });

  /**
  Obtaining a loader or a safe built-in helper remains allowed. Raw process
  has no default property, and import namespaces introduce exactly one default
  layer. These controls catch conflating helpers, raw modules, namespaces and
  transport methods while adding the new loader surface.
  */
  it.each([
    "process.getBuiltinModule('http').Agent;",
    "process.getBuiltinModule('https').Agent;",
    "process.getBuiltinModule('module').createRequire;",
    'process.getBuiltinModule;',
    "import{getBuiltinModule as load}from'process';export{load as fetch};",
    "require('process').default?.getBuiltinModule('http').request;",
    "const p=await import('process');p.default.default?.getBuiltinModule('http').request;",
    "process.getBuiltinModule('process').default?.getBuiltinModule('http').request;",
    "export const Local=process.getBuiltinModule('http').Agent;",
  ])('allows loader helpers and absent raw defaults: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });

  /**
  Local process-shaped clients and explicit type-only references do not acquire
  native transports. These cases reject a spelling-based global fix and retain
  lexical shadowing, parameter bindings and TypeScript erasure barriers.
  */
  it.each([
    "const process={getBuiltinModule(){return{request(){}}}};process.getBuiltinModule('http').request;",
    "const globalThis={process:{getBuiltinModule(){return{request(){}}}}};globalThis.process.getBuiltinModule('http').request;",
    "function use(process={getBuiltinModule(){return{request(){}}}}){process.getBuiltinModule('http').request;}use();",
    "const getBuiltinModule=()=>({request(){}});getBuiltinModule('http').request;",
  ])('keeps local loader-shaped clients local: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });

  /**
  Overload signatures and ambient declarations disappear before runtime.
  They must not diagnose computed native keys that are erased.
  Real TypeScript compilation independently validates these source fixtures.
  */
  it.each([
    "declare namespace Native{function use({[process.getBuiltinModule('https').request.name]:{value}}:any):any;}",
    "class Native{use({[process.getBuiltinModule('http').request.name]:{value}}:any):any;use(input:any){return input;}}",
    "declare function use({[process.getBuiltinModule('http').request.name]:{value}}:any):any;",
  ])('erases type-only built-in loader references: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });
});
