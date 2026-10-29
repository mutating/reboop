import { parser } from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

describe('false positive regressions', () => {
  /**
  Default initializers see outer bindings, not declarations in the function
  body. The same rule applies while following constants used as property
  names or module specifiers, including their own outer initializers. These
  cases catch use-site scope lookup substituting a native transport for a
  local client. Source snippets are linted, never executed.
  */
  it.each([
    "const window={fetch(){}}; function use(root=window){const window=globalThis;root.fetch('/items');}",
    "const window={fetch(){}}; const use=(root=window)=>{const window=globalThis;root.fetch('/items');};",
    "const root={fetch(){}}; const use=function(browser=root){var root=globalThis;browser.fetch('/items');};",
    "const root={fetch(){}}; class View {use(browser=root){let root=globalThis;browser.fetch('/items');}}",
    "const local={window:{fetch(){}}}; function use({window:root}=local){var local=globalThis;root.fetch('/items');}",
    "const key='safe'; function use(root=globalThis[key]){const key='fetch';root();}",
    "const name='./local-client.js';function use(client=require(name)){const name='node-fetch';client('/items');}",
    "const require=localLoader;function use(client=require('axios')){const require=globalThis.require;client('/items');}",
    "const part='safe';const key=part;function use(){const part='fetch';globalThis[key]('/items');}",
    "const suffix='./local-client.js';const name=suffix;function use(){const suffix='node-fetch';require(name)('/items');}",
  ])('retains the actual lexical binding: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });

  /**
  Type-only imports can be forwarded as types without emitting a runtime
  export. In particular an imported type named fetch must not be reclassified
  as the native global after its type-only definition is inspected.
  */
  it.each([
    "import type * as HTTP from 'node:http';export {HTTP};",
    "import type HTTP from 'node:http';export default HTTP;",
    "import type HTTP = require('node:http');export {HTTP};",
    "import type HTTP from 'node:http';export {HTTP as default};",
    "import type {fetch} from 'undici';export {fetch};",
  ])('allows erased TypeScript forwarding: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  Arithmetic/bitwise compound assignments coerce their right operand; they
  do not expose the HTTP namespace as an export. Direct and logical
  assignments are tested separately as positive controls.
  */
  it.each(['+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '|=', '&=', '^='])(
    'allows namespace coercion through %s',
    async (operator) => {
      const result = await lint(
        `const http=require('node:http');module.exports=1;module.exports ${operator} http;`,
        'src/client.cjs',
      );
      expect(result.messages).toEqual([]);
    },
  );

  /**
  Rebinding an implicit CommonJS variable stops it being the original loader
  or export target. These cases guard checking writes before returning the
  predefined-global origin; local replacement objects may receive any value.
  */
  it.each([
    "exports={};const http=require('node:http');exports.http=http;",
    "module={exports:{}};const http=require('node:http');module.exports=http;",
    "require=name=>({local:name});require('axios');",
  ])('allows rebound CommonJS bindings: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([]);
  });

  /**
  CommonJS/raw module objects have no default member. An ESM namespace has
  exactly one default layer. Keeping these origins distinct prevents an
  undefined property from being mistaken for a forwarded HTTP namespace.
  */
  it.each([
    "const http=require('node:http');export const optionalDefault=http.default;",
    "import http from 'node:http';export const optionalDefault=http.default;",
    "export const optionalDefault=(await import('node:http')).default.default;",
  ])('distinguishes raw modules from ESM namespaces: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });

  /**
  A dynamic import is a Promise until awaited; a raw HTTP module is not a
  Promise. Promise unwrapping must be restricted to the actual dynamic-import
  path rather than matching any property or optional method named then.
  */
  it.each([
    "const pending=import('node:http');console.log(typeof pending.request);",
    "const http=require('node:http');http.then?.(({request})=>request('/items'));",
    "import * as http from 'node:http';http.then?.(value=>value.request('/items'));",
  ])('keeps Promise and module values separate: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });

  /**
  Unknown provenance is not proof of an absent property. Safe exports and
  inherited methods must retain their primary value instead of selecting an
  unused default that happens to name a transport. Unknown dynamic-import
  namespaces are still objects supplied to their success callback.
  */
  it.each([
    "const {createServer:root=window}=require('node:http');console.log(typeof root.fetch);",
    "import * as http from 'node:http';const {createServer:root=window}=http;console.log(typeof root.fetch);",
    "import('node:http').then(({createServer:root=window})=>console.log(typeof root.fetch));",
    "const {Headers:root=globalThis}=await import('undici');console.log(typeof root.fetch);",
    "const {createServer:factory=require('node:http')}=require('node:http');export {factory};",
    "const {then:helper=require('node:http')}=import('node:http');export {helper};",
    "const {toString:helper=require('node:http')}=require('node:http');export {helper};",
    "const {root=window}={root:{fetch(){}}};root.fetch('/items');",
    "const {createServer:{fetch:send}=window}=require('node:http');send('/items');",
    "import('./local.js').then((root=window)=>root.fetch('/items'));",
  ])('does not assume an unknown value is missing: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });

  /**
  Sloppy scripts record reassigned implicit globals separately from resolved
  variables. Reusing those definitions must prevent fabricated native loader
  or export-target roles, just as in CommonJS files.
  */
  it.each([
    "require=name=>({local:name});require('axios');",
    "exports={};const http=require('node:http');exports.http=http;",
    "module={exports:{}};const http=require('node:http');module.exports=http;",
  ])('respects implicit script bindings: %s', async (code) => {
    const result = await lint(code, 'src/client.js', [
      { languageOptions: { sourceType: 'script' } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  Annex B creates an extra function-scope binding for block functions in
  non-strict scripts/CommonJS. Even a skipped block shadows the native name;
  the corresponding strict-mode case below must still report native fetch.
  */
  it.each([
    "{function fetch(){return 'local';}}fetch('/items');",
    "if(true){function fetch(){return 'local';}}fetch('/items');",
    "if(false){function fetch(){}}fetch('/items');",
    "{function window(){}}window.fetch('/items');",
    "{function fetch(){}}function use(){fetch('/items');}",
    "{function fetch(){}}{function window(){}}fetch('/items');console.log(typeof window.fetch);",
  ])('respects non-strict block function bindings: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([]);
  });

  /**
  A type-only namespace does not remove Annex B's extra function-scope value.
  Runtime lookup after erasure must visit synthetic hoisted bindings in the
  intervening scopes rather than jumping straight to a predefined global.
  Nested functions and computed keys guard the same lookup in static helpers.
  */
  it.each([
    "{function fetch(){return 'local';}}namespace fetch {export type T=string;}fetch('/items');",
    "{function window(){}}namespace window {export type T=string;}window.fetch('/items');",
    "{function String(){return 'setTimeout';}}namespace String {export type T=string;}console.log(typeof globalThis[String('fetch')]);",
  ])('retains Annex B values beside erased namespaces: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser, sourceType: 'script' } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  Annex B writes to an existing var binding as well as introducing missing
  bindings. Its block function invalidates the var's original transport alias
  or constant key even though the scope manager has no assignment reference.
  Lexical declarations and strict mode are protected by opposite controls.
  */
  it.each([
    'var root=globalThis;{function root(){}}console.log(typeof root.fetch);',
    "var key='fetch';{function key(){return 'setTimeout';}}console.log(typeof globalThis[key]);",
    "var load=require;{function load(name){return {local:name};}}load('axios');",
  ])('accounts for Annex B writes to existing var bindings: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([]);
  });

  /**
  Annex B cannot overwrite lexical bindings, and its outer assignment does
  not exist in strict mode. These calls must remain protected when allowing
  the non-strict var replacement above.
  */
  it.each([
    "let root=globalThis;{function root(){}}root.fetch('/items');",
    "const root=globalThis;{function root(){}}root.fetch('/items');",
    "'use strict';var root=globalThis;{function root(){}}root.fetch('/items');",
  ])('retains aliases that Annex B cannot replace: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  An inner Annex B function shadows an outer immutable alias or constant.
  Scope lookup must visit intervening hoisted bindings before returning an
  outer resolved variable; treating only same-scope var writes is insufficient.
  */
  it.each([
    'const root=globalThis;function use(){{function root(){}}console.log(typeof root.fetch);}',
    "const key='fetch';function use(){{function key(){return 'setTimeout';}}console.log(typeof globalThis[key]);}",
    "const load=require;function use(){{function load(name){return {local:name};}}load('axios');}",
  ])('prefers nearer Annex B values over outer aliases: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([]);
  });

  /**
  Body Annex B bindings are unavailable while evaluating parameter defaults.
  The initializer must retain its actual outer binding, for both local and
  native clients, instead of being shadowed by the later body declaration.
  */
  it.each([
    [
      "const root=globalThis;function use(browser=root){{function root(){}}browser.fetch('/items');}",
      1,
    ],
    [
      "const root={fetch(){}};function use(browser=root){{function root(){}}browser.fetch('/items');}",
      0,
    ],
  ] as const)('keeps default parameters outside body hoisting: %s', async (code, count) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.errorCount).toBe(count);
  });

  /**
  A with environment can supply a local method under any global name. Static
  analysis must leave that dynamic lookup unknown instead of inventing a
  native transport. Code outside that environment remains checked below.
  */
  it.each([
    "with({fetch(){}}){fetch('/items');}",
    "with({window:{fetch(){}}}){window.fetch('/items');}",
    "with({require(){return {};}}){require('axios');}",
  ])('does not guess bindings in a dynamic with environment: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([]);
  });

  /**
  Ambient classes and namespaces only describe types. Extending a native
  transport in that context must not be mistaken for evaluating its runtime
  constructor; an ordinary emitted class remains a positive control.
  */
  it.each([
    'declare class Local extends XMLHttpRequest {}',
    'declare class Local extends globalThis.XMLHttpRequest {}',
    'declare namespace Safe {class Local extends XMLHttpRequest {}}',
    "import * as http from 'node:http';declare class Local extends http.ClientRequest {}",
  ])('allows ambient TypeScript heritage: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  Declaration files are implicitly ambient, including exported classes with
  no declare keyword. All three TypeScript declaration extensions must be
  processed by ESLint without reporting runtime transport access.
  */
  it.each(['d.ts', 'd.mts', 'd.cts'])('allows %s declaration files', async (extension) => {
    const result = await lint(
      'export class Local extends XMLHttpRequest {}',
      `src/client.${extension}`,
      [{ files: ['**/*.{ts,mts,cts}'], languageOptions: { parser } }],
    );
    expect(result.messages).toEqual([]);
  });

  /**
  Interface heritage and implements clauses are erased even when their
  qualified names look like runtime member accesses. Exported type-only
  import-equals declarations must also be skipped by their parent export.
  Runtime extends expressions remain checked by the positive controls.
  */
  it.each([
    'interface Local extends globalThis.XMLHttpRequest {}',
    "import * as http from 'node:http';interface Local extends http.ClientRequest {}",
    'export interface Local extends XMLHttpRequest {} export class Local implements globalThis.XMLHttpRequest {}',
    "import * as http from 'node:http';export interface Local extends http.ClientRequest {} export class Local implements http.ClientRequest {}",
    "export import type HTTP = require('node:http');",
  ])('allows erased heritage and exported type aliases: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  Promise fulfillment supplies one argument. Later destructured parameters
  use their own defaults, not the imported namespace assigned to parameter
  zero. Both ordinary functions and arrows must preserve that distinction.
  */
  it.each([
    "import('node:http').then((unused,{request}={request(){}})=>request('/items'));",
    "import('node:http').then(function named(unused,{get}={get(){}}){get('/items');});",
    "import('undici').then((a,b,{fetch}={fetch(){}})=>fetch('/items'));",
  ])('keeps later callback parameters local: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });

  /**
  ClientRequest is an HTTP export, not an HTTPS export. Sharing request/get
  roles must not invent a constructor that is absent from HTTPS, across
  loader, namespace, default and asynchronous import forms.
  */
  it.each([
    "const https=require('https');console.log(typeof https.ClientRequest);",
    "const https=require('node:https');console.log(typeof https.ClientRequest);",
    "import * as https from 'node:https';console.log(typeof https.ClientRequest);",
    "import https from 'node:https';console.log(typeof https.ClientRequest);",
    "const {ClientRequest}=require('node:https');console.log(typeof ClientRequest);",
    "const https=await import('node:https');console.log(typeof https.ClientRequest);",
  ])('preserves the actual HTTPS export shape: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });

  /**
  CommonJS wrapper bindings are lexical parameters, not standard fields of
  the global object. Optional reads of absent global fields do not acquire
  Node's loader; normal require/module.require are covered positively.
  */
  it.each([
    "globalThis.require?.('node-fetch');",
    "globalThis.module?.require?.('node-fetch');",
    "global.require?.('axios');",
  ])('separates CommonJS bindings from global properties: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([]);
  });

  /**
  An export can refer only to a local type even when its name is also a
  native global value. Keep the original dual-space binding so type erasure
  cannot fabricate an access to fetch or XMLHttpRequest. Runtime calls using
  the same spelling remain covered by the positive controls below.
  */
  it.each([
    'type fetch=()=>void;export {fetch};',
    'type fetch=string;export default fetch;',
    'type fetch=string;export {fetch as alias};',
    'type fetch=string;export {fetch as default};',
    'interface XMLHttpRequest {local:string} export {XMLHttpRequest};',
    'interface XMLHttpRequest {} export default XMLHttpRequest;',
    'namespace fetch {export type X=string;}export {fetch};',
  ])('preserves local type-only export bindings: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  Dot segments can leave a package directory before Node loads a module.
  Both the original and normalized package must be known transports: an
  unknown package can intercept a subpath with package.exports before legacy
  filesystem normalization. Relative paths and builtins retain their kind.
  These paths load local wrappers or remain outside known transport sources.
  */
  it.each([
    'axios/../local-client',
    'node-fetch/../local-client',
    'isomorphic-fetch/../local-client',
    'axios/sub/../../local-client',
    './axios',
    '../axios',
    '/axios',
    'file:///../axios',
    '#local/../axios',
    'local-client/../axios',
    'local-client/sub/../../axios',
    'local-client/../node-fetch',
    'local-client/../http',
    'local-client/../https',
  ])('does not misclassify normalized module paths: %s', async (name) => {
    const result = await lint(
      `const local=require('${name}');local('/items');console.log(typeof local.request);`,
      'src/client.cjs',
    );
    expect(result.messages).toEqual([]);
  });

  /**
  Normalization must retain protected package acquisitions within a package
  and between known transport packages, regardless of exports interception.
  Exact builtin names remain protected through their named HTTP members.
  */
  it.each([
    "require('axios/lib/../index.js');",
    "require('axios/../node-fetch');",
    "require('node:http').request('/items');",
  ])('retains normalized transport acquisition: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.errorCount).toBe(1);
  });

  /**
  Constant evaluation must not invoke the host builtin after that binding
  has been replaced in the inspected program. Otherwise local module paths
  or safe property names are fabricated as HTTP transports. A mutable local
  shadow must also remain a barrier to falling back to the host builtin.
  */
  it.each([
    "String=()=> 'setTimeout';console.log(typeof globalThis[String('fetch')]);",
    "String=()=> './local-client.js';require(String('axios'))('/items');",
    "Array={of(){return ['setTimeout'];}};console.log(typeof globalThis[Array.of('fetch')[0]]);",
    "Object={keys(){return ['setTimeout'];}};console.log(typeof globalThis[Object.keys({fetch:0})[0]]);",
    "let String=x=>x;String=()=> 'setTimeout';console.log(typeof globalThis[String('fetch')]);",
  ])('does not assume a rebound builtin is unchanged: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });

  /**
  Unchanged builtins remain safe to evaluate, so real computed transport
  names and package specifiers still trigger the same rule. This guards
  against solving builtin-rebinding errors by disabling constant evaluation.
  */
  it.each([
    "globalThis[String('fetch')]('/items');",
    "globalThis[Array.of('fetch')[0]]('/items');",
    "globalThis[Object.keys({fetch:0})[0]]('/items');",
    "require(String('axios'));",
  ])('retains unchanged builtin evaluation: %s', async (code) => {
    const result = await lint(code);
    expect(result.errorCount).toBe(1);
  });

  /**
  Erased namespaces share the surviving runtime binding, including its writes.
  A write resolved to an erased symbol must invalidate constant evaluation and
  transport aliases both inside that namespace and in later outer code. These
  cases guard against discarding write metadata during TypeScript erasure.
  */
  it.each([
    "namespace String {export type T=string;}String=(()=> 'setTimeout') as unknown as StringConstructor;console.log(typeof globalThis[String('fetch') as 'setTimeout']);",
    "namespace String {export type T=string;}String=(()=> './local-client.js') as unknown as StringConstructor;require(String('axios'));",
    "namespace Array {export type T=string;}Array=({of(){return ['setTimeout'];}}) as unknown as ArrayConstructor;console.log(typeof globalThis[Array.of('fetch')[0]]);",
    "namespace Object {export type T=string;}Object=({keys(){return ['setTimeout'];}}) as unknown as ObjectConstructor;console.log(typeof globalThis[Object.keys({fetch:0})[0]]);",
    "namespace global {export type T=string;}global=({fetch(){}}) as unknown as typeof global;global.fetch('/items');",
    "let http=require('node:http');namespace Local {namespace http {export type T=string;}http={request(){}} as unknown as typeof http;http.request('/items');}",
    "let http=require('node:http');namespace Local {namespace http {export type T=string;}http={request(){}} as unknown as typeof http;}http.request('/items');",
    "let root=globalThis;namespace Local {namespace root {export type T=string;}root={fetch(){}} as unknown as typeof root;root.fetch('/items');}",
    "let root=globalThis;namespace Local {namespace root {export type T=string;}root={fetch(){}} as unknown as typeof root;}root.fetch('/items');",
    "let key='fetch';namespace Local {namespace key {export type T=string;}key='setTimeout';console.log(typeof globalThis[key as 'setTimeout']);}",
    "let key='fetch';namespace Local {namespace key {export type T=string;}key='setTimeout';}console.log(typeof globalThis[key as 'setTimeout']);",
  ])('preserves writes through erased bindings: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  Static string helpers inside with can come from the dynamic environment.
  Resolving a lexical HTTP namespace does not make its computed key static;
  falling back to the host String would invent a forbidden request or package.
  Local immutable names inside with are covered by positive controls.
  */
  it.each([
    "with({String(){return 'createServer';}}){import('node:http').then(http=>console.log(typeof http[String('request')]));}",
    "async function use(){with({String(){return './local-client.js';}}){const {createRequire}=await import('node:module');const load=createRequire('/tmp/entry.cjs');load(String('axios'));}}",
  ])('does not statically evaluate dynamic with lookups: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([]);
  });

  /**
  Erasing a same-name local type must still reveal the native value during
  actual runtime calls. This prevents solving type-export false positives by
  treating every reference to a local type as a runtime shadow.
  */
  it.each([
    "type fetch=()=>void;fetch('/items');export {};",
    "function use<fetch>(){fetch('/items');}",
    "namespace fetch {export type X=string;}fetch('/items');export {};",
  ])('retains the runtime value beside an erased type: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.errorCount).toBe(1);
  });

  /**
  Assigning an unbound native transport name is still access to the global
  transport. Implicit script variables must not turn such writes into the
  local replacements allowed for CommonJS loader/export bindings.
  */
  it.each(['src/client.js', 'src/client.cjs'])(
    'retains native global writes in %s',
    async (filePath) => {
      const result = await lint('fetch=localClient;', filePath, [
        { languageOptions: { sourceType: filePath.endsWith('.cjs') ? 'commonjs' : 'script' } },
      ]);
      expect(result.errorCount).toBe(1);
    },
  );

  /**
  The corresponding native paths must still report exactly one acquisition.
  These controls prevent solving false positives by dropping default-scope,
  namespace, asynchronous-import or CommonJS-export detection entirely.
  */
  it.each([
    "function use(root=window){var window={};root.fetch('/items');}",
    "function use(send=fetch){var fetch=local;send('/items');}",
    "const part='fetch';const key=part;function use(){const part='safe';globalThis[key]('/items');}",
    "const name='node-fetch';function use(client=require(name)){const name='./local-client.js';client('/items');}",
    "import * as http from 'node:http';export const native=http.default;",
    "export const native=(await import('node:http')).default;",
    "const pending=import('node:http');(await pending).request('/items');",
    "const pending=import('node:http');pending.then(http=>http.request('/items'));",
    "import * as http from 'node:http';const native=flag?http:http;export default native;",
    "const pending=import('node:http');const choice=flag?pending:pending;(await choice).request('/items');",
    "const http=require('node:http');module.exports=http;",
    "const http=require('node:http');module.exports&&=http;",
    "const http=require('node:http');module.exports||=http;",
    "const http=require('node:http');module.exports??=http;",
    "const {default:root=window}=require('node:http');root.fetch('/items');",
    'class Local extends XMLHttpRequest {}',
    "const http=require('http'),https=require('https');const api=flag?http:https;api.request('/items');",
    "import * as http from 'node:http';import * as https from 'node:https';const api=flag?http:https;api.default.request('/items');",
    "const a=import('node:http'),b=import('node:https');const pending=flag?a:b;(await pending).request('/items');",
    "const http=require('node:http'),https=require('node:https');const api=flag?http:https;export default api;",
  ])('retains native transport detection: %s', async (code) => {
    const result = await lint(code);
    expect(result.errorCount).toBe(1);
    expect(result.messages[0]?.ruleId).toBe('reboop/require-client');
  });

  /**
  Strict-mode block functions do not get Annex B's outer binding. The native
  fetch outside the block must still be rejected after allowing sloppy code.
  */
  it('retains strict-mode block-function detection', async () => {
    const result = await lint(
      "'use strict';{function fetch(){}}fetch('/items');",
      'src/client.cjs',
    );
    expect(result.errorCount).toBe(1);
    expect(result.messages[0]?.ruleId).toBe('reboop/require-client');
  });

  /**
  A dynamic with lookup only affects its own environment. Checking the same
  native name afterward prevents suppressing all diagnostics for the file.
  */
  it('retains native access outside the with environment', async () => {
    const result = await lint(
      "with({fetch(){}}){fetch('/local');}fetch('/native');",
      'src/client.cjs',
    );
    expect(result.errorCount).toBe(1);
    expect(result.messages[0]?.ruleId).toBe('reboop/require-client');
  });

  /**
  Annex B applies to block functions, not ordinary lexical declarations. A
  local const may hide fetch inside its block while the subsequent global
  access remains prohibited.
  */
  it('keeps ordinary lexical block bindings inside their block', async () => {
    const result = await lint(
      "{const fetch=localClient;fetch('/local');}fetch('/native');",
      'src/client.cjs',
    );
    expect(result.errorCount).toBe(1);
  });
});
