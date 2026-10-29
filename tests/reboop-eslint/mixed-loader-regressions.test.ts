import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

describe('shared Node loader capabilities', () => {
  /**
  require and getBuiltinModule both return the same HTTP built-ins. Selecting
  either loader must retain that shared capability, regardless of operand order
  or expression carrier. Native Node execution checks both conditional branches
  against the real built-in methods without making network requests. These
  cases protect aliases, destructuring, constructed loaders and createRequire
  results rather than recognizing only an immediate conditional-call spelling.
  */
  it.each([
    "const load=flag?require:process.getBuiltinModule;load('http').request;",
    "const load=flag?process.getBuiltinModule:require;load('node:https').get;",
    "const load=require||process.getBuiltinModule;load('https').request;",
    "const load=process.getBuiltinModule??require;load('node:http').get;",
    "const load=require&&process.getBuiltinModule;load('http').ClientRequest;",
    "const regular=require;const builtin=process.getBuiltinModule;const load=flag?regular:builtin;load('http').get;",
    "const {getBuiltinModule:builtin}=require('process');const load=flag?builtin:require;const {request}=load('https');",
    "const {createRequire}=require('module');const regular=createRequire('/tmp/client.cjs');const load=flag?regular:process.getBuiltinModule;load('node:http').request;",
    "const load=flag?require:process.getBuiltinModule;new load('http').request;",
    "const load=flag?(other?require:process.getBuiltinModule):process.getBuiltinModule;load('https').get;",
    "const load=flag?process.getBuiltinModule:require;module.exports=load('http');",
  ])('retains the built-in capability of a mixed loader: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Imported process helpers and createRequire results have the same capabilities
  as their CommonJS counterparts. Public namespace exports must remain visible
  after the mixed-loader origin is narrowed to built-ins; otherwise moving the
  final property access into another file would bypass the acquisition policy.
  */
  it.each([
    "import{createRequire}from'node:module';import{getBuiltinModule as builtin}from'node:process';const regular=createRequire(import.meta.url);const load=flag?regular:builtin;export const native=load('http');",
    "import{createRequire}from'node:module';import p from'process';const load=flag?p.getBuiltinModule:createRequire(import.meta.url);export default load('https');",
    "import('node:process').then(({getBuiltinModule:builtin})=>{const load=flag?require:builtin;load('http').request;});",
  ])('retains imported mixed-loader namespace origins: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Only built-ins belong to the intersection: getBuiltinModule does not load npm
  clients. Promoting the mixed result to an unrestricted require would report
  these potentially absent values. Safe built-in helpers and an acquired loader
  itself are allowed and must not be confused with HTTP transport acquisition.
  */
  it.each([
    "const load=flag?require:process.getBuiltinModule;load('axios')?.request;",
    "const load=flag?process.getBuiltinModule:require;load('undici')?.fetch;",
    "const load=flag?require:process.getBuiltinModule;load('node-fetch');",
    "const load=flag?require:process.getBuiltinModule;load('axios/lib/client.js');",
    "const load=flag?require:process.getBuiltinModule;load('http').Agent;",
    "const load=flag?process.getBuiltinModule:require;load('https').Agent;",
    "const load=flag?require:process.getBuiltinModule;load('module').createRequire;",
    "const load=flag?process.getBuiltinModule:require;load('process').getBuiltinModule;",
  ])('keeps mixed loading limited to shared built-ins: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([]);
  });

  /**
  An unknown or locally shadowed loader has no proven shared loading behavior.
  Distinct helper roles must also remain distinct: createRequire produces a
  loader rather than an HTTP namespace. Unknown arguments and property keys
  stay unknown, preventing a broad conditional-expression fix from inventing
  a transport origin for unrelated local clients or unresolved accesses.
  Both operand orders protect the symmetric loader guard: one known loader
  cannot turn an unrelated alternative into a guaranteed built-in loader.
  */
  it.each([
    "const local=()=>({request(){}});const load=flag?local:process.getBuiltinModule;load('http').request;",
    "const local=()=>({request(){}});const load=flag?process.getBuiltinModule:local;load('http').request;",
    "const local=()=>({request(){}});const load=flag?local:require;load('http').request;",
    "const require=()=>({request(){}});const load=flag?require:process.getBuiltinModule;load('http').request;",
    "const process={getBuiltinModule:()=>({request(){}})};const load=flag?require:process.getBuiltinModule;load('http').request;",
    "const {createRequire}=require('module');const load=flag?createRequire:process.getBuiltinModule;load('/tmp/client.cjs')?.request;",
    'const load=flag?require:process.getBuiltinModule;load(name).request;',
    "const load=flag?process.getBuiltinModule:require;load('http')[key];",
  ])('does not invent capabilities for unknown alternatives: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([]);
  });
});
