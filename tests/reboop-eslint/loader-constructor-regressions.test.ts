import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

describe('constructible Node loader prototype origins', () => {
  /**
  Native require, getBuiltinModule and createRequire are constructible functions.
  Their prototype.constructor points back to the same loader, rather than an
  unknown application helper. Node execution confirms that these routes obtain
  the exact native HTTP methods without sending requests. The cases preserve
  loader identities through aliases, static keys, patterns and mixed loaders.
  */
  it.each([
    "require.prototype.constructor('http').request;",
    "process.getBuiltinModule.prototype.constructor('node:https').get;",
    "module.require.prototype.constructor('http').ClientRequest;",
    "const {createRequire}=require('module');createRequire.prototype.constructor('/tmp/client.cjs')('http').request;",
    "const load=process.getBuiltinModule;const key='prototype';load[key].constructor('http').request;",
    "const {constructor:load}=require.prototype;load('https').get;",
    "const load=flag?require:process.getBuiltinModule;load.prototype.constructor('http').request;",
    "const {createRequire}=require('module');const load=createRequire('/tmp/client.cjs').prototype.constructor;load('http').get;",
    "const load=flag?require.prototype.constructor:require;load('http').request;",
  ])('retains a loader reached through its prototype: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Static and dynamic imports expose the same process and module loader functions.
  Constructor back-references must retain that identity after namespace/default
  selection and callbacks; public forwarding of a loaded HTTP namespace remains
  an acquisition even when the final property access is in a consumer file.
  */
  it.each([
    "import{getBuiltinModule as load}from'node:process';load.prototype.constructor('http').request;",
    "import{createRequire}from'module';createRequire.prototype.constructor(import.meta.url)('https').get;",
    "const P=await import('node:process');P.default.getBuiltinModule.prototype.constructor('http').request;",
    "import('node:module').then(({Module:{prototype:{require:load}}})=>load.prototype.constructor('http').request);",
    "export default process.getBuiltinModule.prototype.constructor('http');",
  ])('retains imported loader constructor origins: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  A constructor reference preserves the loader's restrictions: built-in loading
  cannot acquire npm packages, including when mixed with ordinary require. A
  loader reference itself is a permitted helper. These cases reject promoting
  every constructor back-reference to unrestricted require or to a transport.
  */
  it.each([
    "process.getBuiltinModule.prototype.constructor('undici')?.fetch;",
    "process.getBuiltinModule.prototype.constructor('axios')?.request;",
    "const load=flag?require:process.getBuiltinModule;load.prototype.constructor('node-fetch');",
    'process.getBuiltinModule.prototype.constructor;',
  ])('preserves built-in-only loading and safe helpers: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([]);
  });

  /**
  The prototype is an ordinary object, not a callable loader. A new non-built-in
  getBuiltinModule result is an ordinary instance and has no prototype property.
  These controls distinguish function, prototype and constructed-instance roles
  instead of assigning the same loader origin to all three shapes.
  */
  it.each([
    "require.prototype('http').request;",
    "const instance=new (process.getBuiltinModule)('axios');instance.prototype?.constructor('http').request;",
  ])('keeps function, prototype and instance shapes distinct: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([]);
  });

  /**
  A familiar loader spelling or prototype.constructor property does not prove
  native identity. Locally defined functions and objects can expose the same
  shape while returning application clients; unknown imports remain unknown.
  These cases reject spelling-based and generic constructor-name recognition.
  */
  it.each([
    "const require=function(){return{request(){}}};require.prototype.constructor('http').request;",
    "const process={getBuiltinModule:function(){return{request(){}}}};process.getBuiltinModule.prototype.constructor('http').request;",
    "import{createRequire}from'./client.js';createRequire.prototype.constructor('/tmp/client.cjs')('http').request;",
    "const value={prototype:{constructor(){return{request(){}}}}};value.prototype.constructor('http').request;",
  ])('keeps local loader-shaped clients local: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });

  /**
  Unknown alternatives must not acquire a proven loader identity. Even when one
  branch exposes a native prototype constructor, the other branch can return a
  local client. The symmetric cases protect both sides of the origin join.
  */
  it.each([
    "const local=function(){return{request(){}}};const load=flag?require:local;load.prototype.constructor('http').request;",
    "const local=function(){return{request(){}}};const load=flag?local:process.getBuiltinModule;load.prototype.constructor('http').request;",
  ])('retains unknown loader alternatives: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([]);
  });

  /**
  Different constructible loader roles share cyclic prototype/constructor shapes
  without sharing their call result. Intersecting these graphs must terminate
  and leave the resulting helper unclassified rather than inventing a transport.
  Removing cycle memoization or treating all helper properties as HTTP would
  make these valid helper-only expressions fail linting.
  */
  it.each([
    "const {createRequire}=require('module');const load=flag?require:createRequire;load.prototype.constructor;",
    "const {createRequire}=require('module');const load=flag?process.getBuiltinModule:createRequire;load.prototype.constructor;",
  ])('terminates mixed loader-role graph intersections: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([]);
  });
});
