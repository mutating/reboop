import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

describe('Node Module namespace and constructor shapes', () => {
  /**
  Module.prototype is a non-enumerable constructor property, not a named ESM
  export. Namespace-only optional accesses never read an HTTP transport. The
  cases reject copying raw constructor fields into static, dynamic or callback
  import namespaces. Mixed raw/namespace branches have no shared prototype
  origin; a local fallback also keeps its own implementation.
  */
  it.each([
    "import*as M from'node:module';M.prototype?.require('http').request;",
    "const M=await import('module');M.prototype?.require('http').request;",
    "import('node:module').then(({prototype:p})=>p?.require('http').request);",
    "const {prototype:p}=await import('node:module');p?.require('https').get;",
    "import('module').then((M)=>{const{prototype:p}=M;p?.require('http').request;});",
    "import*as M from'module';const key='prototype';M[key]?.require('http').request;",
    "const M=flag?await import('module'):await import('node:module');M.prototype?.require('http').request;",
    "import*as N from'node:module';const M=flag?N:N.default;M.prototype?.require('http').request;",
    "import*as M from'node:module';const{prototype:p={require(){return{request(){}}}}}=M;p.require('http').request;",
    "import*as M from'node:module';const p=flag?M.prototype:M.Module.prototype;p?.require('http').request;",
  ])('keeps a namespace prototype absent: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });

  /**
  The raw built-in is the actual Module constructor and retains its prototype.
  Both the namespace's default and its named Module export refer to that raw
  constructor. These controls prevent fixing the namespace false positive by
  deleting prototype tracking everywhere or stripping the real constructor's
  fields while it is reached through an import namespace.
  */
  it.each([
    "import M from'node:module';M.prototype.require('http').request;",
    "import{Module as M}from'module';M.prototype.require('https').get;",
    "import*as M from'node:module';M.default.prototype.require('http').request;",
    "import*as M from'module';M.Module.prototype.require('http').request;",
    "import*as M from'node:module';M.default.Module.prototype.require('http').request;",
    "const M=await import('node:module');M.default.prototype.require('http').request;",
    "import('module').then(({default:M})=>M.prototype.require('http').request);",
    "import('node:module').then(({Module:M})=>M.prototype.require('http').request);",
  ])('retains the raw constructor prototype: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  CommonJS and the built-in-only process loader return the raw constructor,
  rather than an ESM namespace. Constructor shape corrections must leave both
  ordinary loader routes intact and must not add a default layer to raw values.
  */
  it.each([
    "require('module').prototype.require('http').request;",
    "process.getBuiltinModule('node:module').prototype.require('https').get;",
  ])('retains raw loader prototype origins: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  An absent named export activates a destructuring default. Merely deleting
  prototype from the known namespace map makes it unknown and would lose these
  real acquisitions. The namespace must record absence while retaining raw
  default/Module prototypes, including nested patterns and callback defaults.
  */
  it.each([
    "import*as M from'node:module';const{prototype=M.default.prototype}=M;prototype.require('http').request;",
    "const M=await import('module');const{prototype=M.Module.prototype}=M;prototype.require('https').get;",
    "import*as M from'node:module';const{prototype:{require:load}=M.default.prototype}=M;load('http').request;",
    "import*as M from'module';const key='prototype';const{[key]:p=M.Module.prototype}=M;p.require('http').request;",
    "import('node:module').then((M)=>{const{prototype=M.default.prototype}=M;prototype.require('http').request;});",
    "import('module').then(({prototype=process.getBuiltinModule('module').prototype})=>prototype.require('http').request);",
    "import*as M from'node:module';const{prototype=M.default.prototype}=M;export default prototype.require('http');",
  ])('resolves an absent namespace prototype default: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });
});
