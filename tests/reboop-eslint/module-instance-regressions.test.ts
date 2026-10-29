import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

describe('Node Module instance and prototype loader regressions', () => {
  /**
  Module and its Module property are the same constructor. Constructing either
  produces an instance whose require method loads native HTTP modules; the
  public prototype exposes the same working loader. The CommonJS wrapper module
  is already an instance and exposes its constructor. These cases protect those
  roots, detached loader aliases and statically computed prototype keys from
  becoming unknown origins. Node execution confirms exact HTTP method identity.
  */
  it.each([
    "new (require('module'))().require('http').request;",
    "module.constructor.createRequire('/tmp/entry.cjs')('http').request;",
    "new (require('node:module').Module)().require('node:https').get;",
    "require('module').prototype.require('http').request;",
    "require('node:module').Module.prototype.require('node:http').ClientRequest;",
    "const {Module:Ctor}=require('module');const instance=new Ctor();const {require:load}=instance;load('https').request;",
    "const M=require('module');const proto=M.prototype;const key='require';proto[key]('http').get;",
  ])('detects an instance or prototype loader: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Default imports expose the constructor, while module namespaces expose it as
  Module and default. Built-in process loading and dynamic imports must preserve
  those identities through the existing resolver rather than requiring direct
  require syntax. Every case still acquires one native HTTP transport.
  */
  it.each([
    "import M from'module';new M().require('http').request;",
    "import {Module as M}from'node:module';new M().require('https').get;",
    "import*as M from'module';new M.Module().require('http').request;",
    "import*as M from'node:module';new M.default().require('http').get;",
    "const M=await import('node:module');new M.Module().require('https').request;",
    "new (process.getBuiltinModule('module'))().require('http').request;",
  ])('detects a constructor reached through module loading: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  The prototype constructor points back to Module. That reference can construct
  another instance or supply createRequire; public namespace forwarding must
  also retain the loaded origin. The dedicated-package fixture checks that an
  obtained ordinary require is unrestricted, unlike process.getBuiltinModule.
  */
  it.each([
    "const M=require('module');new M().constructor.createRequire('/tmp/entry.cjs')('https').get;",
    "const M=require('module');new M.prototype.constructor.Module().require('http').request;",
    "const M=require('module');const load=new M().constructor.createRequire('/tmp/entry.cjs');load('node-fetch');",
    "export default new (process.getBuiltinModule('module'))().require('http');",
    "import M from'node:module';export const native=M.prototype.require('https');",
  ])('retains constructor factories and public namespace origins: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Module.require is absent: require belongs to instances and the prototype.
  Raw modules, instances and their prototype have no default namespace layer.
  A fix that shares the constructor and instance maps, or invents default
  properties, would turn these short-circuited expressions into false reports.
  */
  it.each([
    "require('module').require?.('axios');",
    "module.prototype?.require('axios');",
    "module.Module?.prototype.require('axios');",
    "require('module').default?.prototype.require('axios');",
    "require('module').prototype.default?.require('axios');",
    "new (require('module'))().default?.require('axios');",
    "new (require('module'))().createRequire?.('/tmp/entry.cjs')('axios');",
  ])('keeps static, instance and namespace shapes distinct: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([]);
  });

  /**
  A Module call does not construct an instance. The detached constructor call
  throws, while calling the Module property returns undefined; neither yields
  a require method. Safe constructor/prototype helpers also remain allowed.
  These controls catch applying instance origins to ordinary calls or treating
  every property of Module as a transport.
  */
  it.each([
    "require('module')().require('http').request;",
    "require('module').Module()?.require('http').request;",
    "require('module').prototype.constructor;",
    "new (require('module'))().constructor.createRequire;",
  ])('allows non-constructing calls and safe helpers: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([]);
  });

  /**
  Local constructors and prototype-shaped objects keep their own clients. An
  instance's exports object is private and is not the active CommonJS wrapper's
  public exports target. These controls reject method-name matching and sharing
  exportsObject with arbitrary Module instances.
  */
  it.each([
    "class Module{require(){return{request(){}}}}new Module().require('http').request;",
    "const M={prototype:{require(){return{request(){}}}}};M.prototype.require('http').request;",
    "const M=require('module');const instance=new M();instance.exports=require('http');",
    "const M=require('module');const {exports:target}=new M();target.native=require('http');",
  ])('keeps local clients and private instance exports private: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([]);
  });
});
