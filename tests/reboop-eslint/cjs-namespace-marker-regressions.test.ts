import { parser } from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

describe('Node CommonJS namespace export markers', () => {
  /**
  Node 23 and newer expose a CommonJS module's raw exports as the namespace's
  module.exports export, alongside default. Undici's marker therefore supplies
  the same native transports through named imports, namespace fields, dynamic
  import callbacks and destructuring. Real Node execution confirms raw-module
  identity without making requests. These cases guard every supported import
  route rather than recognizing only one property-access spelling.
  */
  it.each([
    "import{'module.exports' as raw}from'undici';raw.fetch;",
    "import*as U from'undici';U['module.exports'].request;",
    "import*as U from'undici';const key='module.exports';const raw=U[key];raw.connect;",
    "const U=await import('undici');U['module.exports'].fetch;",
    "import('undici').then(({'module.exports':raw})=>raw.request);",
    "const {'module.exports':{fetch}}=await import('undici');",
    "import*as U from'undici';const raw=flag?U.default:U['module.exports'];raw.fetch;",
  ])('retains the raw Undici module through its marker: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  A marker can forward an entire known HTTP namespace or supply Agent's allowed
  constructor before a prohibited HTTP method is acquired. These cases protect
  public forwarding and existing instance origins after traversing the marker;
  merely banning a named marker import would reject permitted helper access.
  */
  it.each([
    "export{'module.exports' as native}from'undici';",
    "import{'module.exports' as raw}from'undici';export default raw;",
    "const U=await import('undici');export const native=U['module.exports'];",
    "import{'module.exports' as raw}from'undici';new raw.Agent().request;",
    "import*as U from'undici';const A=U['module.exports'].Agent;new A.prototype.constructor().dispatch;",
  ])('retains namespace and Agent origins through the marker: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Node's built-in ESM namespaces do not expose this CommonJS marker. Adding it
  to every namespace would invent HTTP modules or loaders in these expressions.
  The real built-ins were checked for own-property absence as runtime controls.
  */
  it.each([
    "import*as H from'node:http';H['module.exports']?.request;",
    "const H=await import('https');H['module.exports']?.get;",
    "import*as M from'node:module';M['module.exports']?.createRequire('/tmp/client.cjs')('http').request;",
    "import('node:process').then(({'module.exports':p})=>p?.getBuiltinModule('http').request);",
  ])('does not invent markers on built-in namespaces: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });

  /**
  The marker is a namespace export, not a property added to raw CommonJS exports.
  Its value has no extra default layer either. These controls reject circular
  raw-module aliases and repeated namespace wrapping, both of which would make
  short-circuited expressions look like transport acquisitions.
  */
  it.each([
    "require('undici')['module.exports']?.fetch;",
    "import U from'undici';U['module.exports']?.request;",
    "import*as U from'undici';U.default['module.exports']?.fetch;",
    "import*as U from'undici';U['module.exports'].default?.fetch;",
  ])('keeps raw modules separate from namespace markers: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });

  /**
  Obtaining a raw namespace or its non-network helpers remains permitted. The
  same marker spelling on local modules and objects does not establish native
  identity. These cases catch fixes that classify every marker or every Undici
  export as a transport instead of following the known namespace origin.
  */
  it.each([
    "import{'module.exports' as raw}from'undici';export const Header=raw.Headers;",
    "const U=await import('undici');export const Agent=U['module.exports'].Agent;",
    "import*as U from'./client.js';U['module.exports'].fetch;",
    "const U={'module.exports':{fetch(){}}};U['module.exports'].fetch;",
  ])('allows helpers and local marker-shaped values: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });

  /**
  Ambient function signatures and method overload parameters erase their
  computed binding keys. Resolving the marker must not turn those expressions
  into runtime acquisitions. Strict compilation and emitted-code execution
  validate erasure; mutation challenges break the respective erasure barriers.
  */
  it.each([
    "import*as U from'undici';declare function use({[(U as any)['module.exports'].fetch.name]:{value}}:any):any;",
    "import*as U from'undici';class Local{use({[(U as any)['module.exports'].fetch.name]:{value}}:any):any;use(input:any){return input;}}",
  ])('retains TypeScript erasure around a marker reference: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });
});
