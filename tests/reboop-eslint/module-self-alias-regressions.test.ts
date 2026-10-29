import { parser } from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

describe('Node module constructor self-alias integration regressions', () => {
  /**
  Node exports its Module constructor as the module value and as its own Module
  property. Both names expose the same createRequire factory. These cases guard
  against losing that identity through imports, destructuring, static keys and
  repeated self-aliases. Real Node execution confirms the resulting request/get
  references are native without sending any requests.
  */
  it.each([
    "import{Module}from'node:module';Module.createRequire('/tmp/client.cjs')('http').request;",
    "import{Module as M}from'module';M.Module.createRequire('/tmp/client.cjs')('https').get;",
    "import*as M from'node:module';M.Module.createRequire('/tmp/client.cjs')('node:http').request;",
    "import M from'node:module';M.Module.Module.createRequire('/tmp/client.cjs')('node:https').get;",
    "require('module').Module.createRequire('/tmp/client.cjs')('http').request;",
    "const {Module:{createRequire:factory}}=require('node:module');factory('/tmp/client.cjs')('https').get;",
    "const M=require('module');const key='Mod'+'ule';M[key].createRequire('/tmp/client.cjs')('http').ClientRequest;",
    "const M=require('module').Module;const load=new M.createRequire('/tmp/client.cjs');load('http').request;",
  ])('retains the self-alias factory: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Dynamic imports wrap the raw module in a namespace, while getBuiltinModule
  returns the raw value directly. Existing Promise, default-layer and export
  tracking must all retain Module's self-alias. Public HTTP namespace forwarding
  remains a violation even when the final expression does not select request.
  */
  it.each([
    "const M=await import('node:module');M.Module.createRequire('/tmp/client.cjs')('http').request;",
    "const M=await import('module');M.default.Module.createRequire('/tmp/client.cjs')('https').get;",
    "import('node:module').then(({Module:M})=>M.createRequire('/tmp/client.cjs')('http').request);",
    "import('module').then(({default:{Module:{createRequire:factory}}})=>factory('/tmp/client.cjs')('https').get);",
    "process.getBuiltinModule('module').Module.createRequire('/tmp/client.cjs')('http').request;",
    "process.getBuiltinModule('node:module').Module.Module.createRequire('/tmp/client.cjs')('https').get;",
    "import{Module}from'node:module';export default Module.createRequire('/tmp/client.cjs')('https');",
    "const {Module}=require('module');module.exports=Module.createRequire('/tmp/client.cjs')('http');",
  ])('retains self-aliases across loader and export forms: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  The self-alias is a module loader helper, not an HTTP transport. Its other
  helpers and public forwarding stay allowed. Only import namespaces introduce
  a default layer; making the raw Module constructor its own default would
  wrongly revive the otherwise absent accesses in these controls.
  */
  it.each([
    "import{Module}from'node:module';Module.isBuiltin('http');",
    "const M=require('module').Module;M.builtinModules;",
    "import{Module}from'node:module';export{Module};",
    "export const M=require('module').Module;",
    "require('module').Module.default?.createRequire('/tmp/client.cjs')('http').request;",
    "const M=await import('module');M.Module.default?.createRequire('/tmp/client.cjs')('http').request;",
    "process.getBuiltinModule('module').Module.default?.createRequire('/tmp/client.cjs')('http').request;",
    "import{Module}from'node:module';Module.createRequire('/tmp/client.cjs')('http').Agent;",
  ])('keeps helpers and absent defaults safe: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });

  /**
  A matching property spelling does not prove a native loader. Local classes,
  values, imported clients and erased declarations must keep their own origins.
  These controls reject name-based fixes and preserve explicit type erasure.
  */
  it.each([
    "const Module={createRequire(){return()=>({request(){}})}};Module.createRequire('/tmp/client.cjs')('http').request;",
    "function use(Module={createRequire(){return()=>({request(){}})}}){Module.createRequire('/tmp/client.cjs')('http').request;}use();",
    "const require=()=>({Module:{createRequire(){return()=>({request(){}})}}});require('module').Module.createRequire('/tmp/client.cjs')('http').request;",
    "import{Module}from'./local-client.js';Module.createRequire('/tmp/client.cjs')('http').request;",
  ])('retains local and unknown Module bindings: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });

  /**
  TypeScript import-equals and value wrappers preserve the same runtime Module
  alias. Explicit type imports and ambient declarations erase it completely.
  Semantic TypeScript compilation independently validates these fixtures.
  */
  it.each([
    [
      "import M=require('node:module');M.Module.createRequire('/tmp/client.cjs')('http').request;",
      1,
    ],
    [
      "import{Module}from'node:module';(Module.Module as typeof Module).createRequire('/tmp/client.cjs')('http').request;",
      1,
    ],
    [
      "import type{Module}from'node:module';declare function use({[process.getBuiltinModule('module').Module.createRequire('/tmp/client.cjs')('http').request.name]:{value}}:any):Module;",
      0,
    ],
  ] as const)('retains runtime identity and erases types: %s', async (code, count) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toHaveLength(count);
    if (count > 0) {
      expect(result.messages[0]?.ruleId).toBe('reboop/require-client');
    }
  });
});
