import { parser } from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

describe('scope and type erasure regressions', () => {
  /**
  A block binding may combine a runtime function and erased interface metadata.
  One FunctionName definition still installs its Annex B shadow. Requiring all
  definitions to be functions loses that shadow and invents native Fetch at the
  later call. A later distinct function must also preserve the earlier name
  in the same table. Predicate-direction and table-reset mutants catch both.
  */
  it.each(['script', 'commonjs'] as const)(
    'retains a hoisted function beside erased definitions in %s',
    async (sourceType) => {
      const code =
        "{function fetch(){}interface fetch{value:string}function marker(){}}fetch('/api');";
      const result = await lint(code, 'src/client.ts', [
        { files: ['**/*.ts'], languageOptions: { parser, sourceType } },
      ]);
      expect(result.messages).toEqual([]);
    },
  );

  /**
  TypeScript's namespace and enum scopes are marked strict by the parser,
  but script emit with alwaysStrict=false uses ordinary sloppy IIFEs.
  Their Annex B functions remain local runtime bindings, including inside
  nested functions, arrows and switches, and beside erased declarations.
  */
  it.each([
    "namespace N{{function fetch(input:string){return 'local';}}console.log(fetch('/items'));}",
    'enum E{Value=(()=>{{function fetch(){return 1;}}return fetch();})()}console.log(E.Value);',
    "namespace N{function use(){{function fetch(input:string){return 'local';}}console.log(fetch('/items'));}use();}",
    "namespace N{const use=()=>{{function fetch(input:string){return 'local';}}console.log(fetch('/items'));};use();}",
    'const root=globalThis;namespace N{switch(0){case 0:function root(){}}console.log(typeof (root as unknown as {fetch?:unknown}).fetch);}',
    'const root=globalThis;namespace N{interface root{};{function root(){}}console.log(typeof (root as unknown as {fetch?:unknown}).fetch);}',
    "namespace N{{function String(input:string){return 'setTimeout';}}console.log(typeof globalThis[String('fetch') as 'fetch']);}",
  ])('retains Annex B locals in emitted TypeScript scopes: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser, sourceType: 'script' } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  Parentheses and escapes prevent a use-strict directive. A string after a
  runtime statement also lies outside the directive prologue. These forms
  preserve sloppy bindings at script, emitted namespace and function level.
  */
  it.each([
    "('use strict');namespace N{{function fetch(input:string){return 'local';}}console.log(fetch('/items'));}",
    "'use\\x20strict';namespace N{{function fetch(input:string){return 'local';}}console.log(fetch('/items'));}",
    "void 0;'use strict';namespace N{{function fetch(input:string){return 'local';}}console.log(fetch('/items'));}",
    "namespace N{('use strict');{function fetch(input:string){return 'local';}}console.log(fetch('/items'));}",
    "namespace N{'use\\x20strict';{function fetch(input:string){return 'local';}}console.log(fetch('/items'));}",
    "namespace N{'use\\x20strict' as string;{function fetch(){}}console.log(typeof fetch);}",
    "namespace N{0;'use strict';{function fetch(input:string){return 'local';}}console.log(fetch('/items'));}",
    "namespace N{void 0;'use strict';{function fetch(input:string){return 'local';}}console.log(fetch('/items'));}",
    "namespace N{function use(){('use strict');{function fetch(input:string){return 'local';}}console.log(fetch('/items'));}use();}",
    "namespace N{function use(){'use\\x20strict';{function fetch(input:string){return 'local';}}console.log(fetch('/items'));}use();}",
    "namespace N{function use(){void 0;'use strict';{function fetch(input:string){return 'local';}}console.log(fetch('/items'));}use();}",
  ])('keeps non-directive strings outside runtime strictness: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser, sourceType: 'script' } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  Actual directives, classes and modules retain strict runtime lookup.
  Directive promotion after erased declarations depends on the compiler;
  these preservation cases retain the parser's strictness and match tsc's emit.
  Hoisted locals also cannot escape their emitted IIFE and hide an independent
  native acquisition in the outer script.
  */
  it.each([
    "'use strict';namespace N{{function fetch(input:string){return 'local';}}console.log(typeof fetch);}",
    "namespace N{'use strict';{function fetch(input:string){return 'local';}}console.log(typeof fetch);}",
    'namespace N{"use strict";{function fetch(){}}console.log(typeof fetch);}',
    "namespace N{'custom';'use strict';{function fetch(input:string){return 'local';}}console.log(typeof fetch);}",
    "namespace N{function use(){'use strict';{function fetch(input:string){return 'local';}}console.log(typeof fetch);}use();}",
    "namespace N{class Use{method(){{function fetch(input:string){return 'local';}}console.log(typeof fetch);}}new Use().method();}",
    "namespace N{type T=string;'use strict';{function fetch(input:string){return 'local';}}console.log(typeof fetch);}",
    "namespace N{export declare class Local{}'use strict';{function fetch(){}}console.log(typeof fetch);}",
    'const root=globalThis;namespace N{{function root(){}}}console.log(typeof root.fetch);',
  ])('retains native lookup around emitted TypeScript scopes: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser, sourceType: 'script' } },
    ]);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  it('retains strict native lookup in an ESM namespace', async () => {
    const result = await lint(
      "namespace N{{function fetch(input:string){return 'local';}}console.log(typeof fetch);}export {};",
      'src/client.ts',
      [{ files: ['**/*.ts'], languageOptions: { parser } }],
    );
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  A generic type parameter can share its scope variable with a body value.
  That merged metadata must not make body declarations visible in parameter
  defaults: after erasure they still read the outer value. The same boundary
  applies inside nested closures/classes and while evaluating constant keys
  or module names. A named function expression also supplies its own outer
  value, while an actual earlier parameter remains visible to later defaults.
  */
  it.each([
    'const root={fetch(){}};function use<root>(value=root){var root=globalThis;value.fetch();}use();export {};',
    'const root={fetch(){}};function use<root>(value=root){let root=globalThis;value.fetch();}use();export {};',
    'const root={fetch(){}};const use=<root>(value=root)=>{const root=globalThis;value.fetch();};use();export {};',
    'const root={fetch(){}};const use=function<root>(value=root){var root=globalThis;value.fetch();};use();export {};',
    'const root={fetch(){}};const local={use<root>(value=root){var root=globalThis;value.fetch();}};local.use();export {};',
    'const root={fetch(){}};class Local {use<root>(value=root){var root=globalThis;value.fetch();}}new Local().use();export {};',
    "const key='setTimeout';function use<key>(value=globalThis[key]){var key='fetch';console.log(typeof value);}use();export {};",
    "const key='setTimeout';function use<key>({value=globalThis[key]}={}){let key='fetch';console.log(typeof value);}use();export {};",
    "const key='setTimeout';function use<key>(value=()=>globalThis[key]){const key='fetch';console.log(typeof value());}use();export {};",
    "const key='setTimeout';function use<key>(value=class {method(){return globalThis[key];}}){var key='fetch';console.log(typeof new value().method());}use();export {};",
    "const name='./local';function use<name>(value=require(name)){var name='axios';console.log(value);}use();export {};",
    "const name='./local';function use<name>(value=()=>require(name)){const name='axios';console.log(value());}use();export {};",
    'const root=globalThis;const use=function root<root>(value=root){var root=globalThis;console.log(typeof (value as unknown as {fetch?:unknown}).fetch);};use();export {};',
    'const root=globalThis;function use<root>(root={fetch(){}},value=root){value.fetch();}use();export {};',
  ])('keeps generic parameter defaults outside body bindings: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  Runtime parameters remain available to later defaults, body reads retain
  their body binding, and a native outer value still reaches its default.
  Checking the reported column prevents a fabricated default acquisition
  from replacing the real body acquisition while preserving the same count.
  */
  it.each([
    [
      'function use<root>(root=globalThis,value=root){console.log(typeof value.fetch);}use();export {};',
      'value.fetch',
    ],
    [
      'const use=<root>(root=globalThis,value=root)=>{console.log(typeof value.fetch);};use();export {};',
      'value.fetch',
    ],
    [
      'const root=globalThis;function use<root>(value=root){const root={fetch(){}};console.log(typeof value.fetch);}use();export {};',
      'value.fetch',
    ],
    [
      'const root={fetch(){}};function use<root>(value=root){var root=globalThis;console.log(typeof value.fetch);console.log(typeof root.fetch);}use();export {};',
      'root.fetch',
    ],
    [
      "const key='setTimeout';function use<key>(value=globalThis[key]){const key='fetch';console.log(typeof value);console.log(typeof globalThis[key]);}use();export {};",
      'globalThis[key]',
    ],
    [
      'const root={fetch(){}};function use(value=root){var root=globalThis;console.log(typeof value.fetch);console.log(typeof root.fetch);}use();export {};',
      'root.fetch',
    ],
  ])(
    'retains the actual runtime binding beside generic defaults: %s',
    async (code, acquisition) => {
      const result = await lint(code, 'src/client.ts', [
        { files: ['**/*.ts'], languageOptions: { parser } },
      ]);
      expect(result.messages).toEqual([
        expect.objectContaining({
          ruleId: 'reboop/require-client',
          column: code.lastIndexOf(acquisition) + 1,
        }),
      ]);
    },
  );

  /**
  These non-strict TypeScript scripts are valid with alwaysStrict=false.
  Ordinary functions own an implicit arguments object even when an erased
  type alias, interface or type parameter shares its scope variable. The
  parser can resolve the value reference to the outer constant after that
  merge; runtime still uses the function's arguments object. Following the
  outer string or root invents a native transport acquisition. An annotation
  also checks type and value lookups through the shared arguments spelling.
  Defaults use that implicit object even beside a same-name generic and body var.
  */
  it.each([
    "const arguments='fetch';function use(){type arguments=string;console.log(typeof globalThis[String(arguments)]);}use();",
    "const arguments='fetch';function use(){interface arguments{}console.log(typeof globalThis[String(arguments)]);}use();",
    "const arguments='fetch';function use<arguments>(){console.log(typeof globalThis[String(arguments)]);}use();",
    "const arguments='fetch';const use=function(){type arguments=string;console.log(typeof globalThis[String(arguments)]);};use();",
    "const arguments='fetch';const local={use(){interface arguments{}console.log(typeof globalThis[String(arguments)]);}};local.use();",
    "const arguments='fetch';function use<arguments>(){(()=>console.log(typeof globalThis[String(arguments)]))();}use();",
    'const arguments=globalThis;function use(){type arguments=string;console.log(typeof (arguments as unknown as {fetch?:unknown}).fetch);}use();',
    "const arguments='fetch';function use(){type arguments=string;let annotation:arguments|undefined;void annotation;console.log(typeof globalThis[String(arguments)]);}use();",
    'const arguments=globalThis;function use<arguments>(value=arguments){var arguments=globalThis;console.log(typeof (value as unknown as {fetch?:unknown}).fetch);}use();',
  ])('preserves implicit arguments beside erased types: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser, sourceType: 'script' } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  Arrows capture the outer arguments binding, while explicit parameters and
  var initializers replace an ordinary function's arguments value. Erased
  types must preserve these actual native strings and roots; treating every
  arguments reference as an unknown implicit object loses protection here.
  */
  it.each([
    "const arguments='fetch';const use=()=>{type arguments=string;console.log(typeof globalThis[String(arguments)]);};use();",
    "const arguments='fetch';const use=()=>{interface arguments{}console.log(typeof globalThis[String(arguments)]);};use();",
    "const arguments='fetch';const use=<arguments>()=>{console.log(typeof globalThis[String(arguments)]);};use();",
    "const arguments='fetch';function use(arguments=globalThis){type arguments=string;console.log(typeof arguments.fetch);}use();",
    "const arguments='fetch';function use<arguments>(arguments=globalThis){console.log(typeof arguments.fetch);}use();",
    "const arguments='fetch';function use(){type arguments=string;var arguments=globalThis;console.log(typeof arguments.fetch);}use();",
    "const arguments='fetch';function use<arguments>(){var arguments=globalThis;console.log(typeof arguments.fetch);}use();",
  ])('retains explicit arguments values beside erased types: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser, sourceType: 'script' } },
    ]);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Type queries in value declarations are erased even without an enclosing
  type alias or interface. Removing the type-query ancestor check reports
  these annotations as native transport acquisitions.
  */
  it.each(['export let send: typeof fetch;', 'export let constructor: typeof XMLHttpRequest;'])(
    'allows an erased type-query annotation: %s',
    async (code) => {
      const result = await lint(code, 'src/client.ts', [
        { files: ['**/*.ts'], languageOptions: { parser } },
      ]);
      expect(result.messages).toEqual([]);
    },
  );

  /**
  XMLHttpRequest.DONE is the literal numeric key 4, so these are valid
  computed type properties with no runtime access. They specifically catch
  treating computed type keys as runtime expressions even when typeof
  annotations are still recognized.
  */
  it.each([
    'type Local = {[XMLHttpRequest.DONE]: string}; export {};',
    'type Local = {[globalThis.XMLHttpRequest.DONE]: string}; export {};',
  ])('allows computed keys in an erased type alias: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  Inline type literals erase their computed keys just as type aliases do.
  XMLHttpRequest.DONE has the literal type 4, so these annotations, assertions
  and generic arguments are valid TypeScript without a runtime acquisition.
  Checking only enclosing aliases or interfaces reports every spelling here.
  */
  it.each([
    'export let local: {[XMLHttpRequest.DONE]: string};',
    'export let local: {[globalThis.XMLHttpRequest.DONE]: string};',
    'export function use(local:{[XMLHttpRequest.DONE]:string}){return local;}',
    "export function use():{[XMLHttpRequest.DONE]:string}{return {4:'local'};}",
    'export class Local {value!:{[XMLHttpRequest.DONE]:string};}',
    "export const local={4:'local'} as {[XMLHttpRequest.DONE]:string};",
    "export const local={4:'local'} satisfies {[XMLHttpRequest.DONE]:string};",
    'export function use<T extends {[XMLHttpRequest.DONE]:string}>(local:T){return local;}',
    'function use<T>(){}use<{[XMLHttpRequest.DONE]:string}>();export {};',
    'class Local<T>{}new Local<{[XMLHttpRequest.DONE]:string}>();export {};',
    'export let local:{[XMLHttpRequest.DONE]():string};',
    'function decorate(...args:unknown[]){}export abstract class Local {@decorate abstract value:{[XMLHttpRequest.DONE]:string};}',
  ])('allows erased inline computed type keys: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  Undecorated abstract members erase their definitions and computed names.
  Properties, methods and accessors therefore cannot acquire a native
  constructor merely by naming its literal DONE key in an erased signature.
  The enclosing abstract class still emits and is checked separately below.
  */
  it.each([
    'export abstract class Local {abstract [XMLHttpRequest.DONE]:string;}',
    'export abstract class Local {abstract [globalThis.XMLHttpRequest.DONE]:string;}',
    'export abstract class Local {abstract [XMLHttpRequest.DONE]():string;}',
    'export abstract class Local {abstract [globalThis.XMLHttpRequest.DONE]():string;}',
    'export abstract class Local {abstract get [XMLHttpRequest.DONE]():string;}',
    'export abstract class Local {abstract set [globalThis.XMLHttpRequest.DONE](value:string);}',
    'export abstract class Local {abstract accessor [XMLHttpRequest.DONE]:string;}',
  ])('allows erased abstract computed member names: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  An overload signature erases its computed name; the implementation evaluates
  its own name once. Both declarations use the same valid literal key, but
  only the implementation's constructor reference is a runtime acquisition.
  A count alone could pass while retaining the wrong, erased occurrence.
  */
  it.each(['XMLHttpRequest', 'globalThis.XMLHttpRequest'])(
    'reports only the runtime overload name for %s',
    async (constructor) => {
      const code = `export class Local {
  [${constructor}.DONE]():string;
  [${constructor}.DONE](){return 'local';}
}`;
      const result = await lint(code, 'src/client.ts', [
        { files: ['**/*.ts'], languageOptions: { parser } },
      ]);
      expect(result.messages).toEqual([
        expect.objectContaining({ ruleId: 'reboop/require-client', line: 3, column: 4 }),
      ]);
    },
  );

  /**
  Type assertions retain their value expression, and abstract classes still
  evaluate their base and concrete member names. Erasure checks must not skip
  these runtime paths while allowing inline types and abstract signatures.
  */
  it.each([
    "export const local = {[XMLHttpRequest.DONE]:'local'};",
    "export const local = {[globalThis.XMLHttpRequest.DONE]:'local'};",
    'export const local=XMLHttpRequest as unknown;',
    'export const local=XMLHttpRequest satisfies Function;',
    "export abstract class Local {[XMLHttpRequest.DONE]='local';}",
    "export abstract class Local {[globalThis.XMLHttpRequest.DONE](){return 'local';}}",
    'export abstract class Local extends XMLHttpRequest {}',
  ])('retains emitted access beside erased types: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Legacy decorators emit an abstract property's computed name and invoke
  decorator expressions even though its field has no runtime definition.
  Abstract auto-accessors follow the same path. Skipping every abstract node
  would lose these acquisitions while fixing undecorated signatures above.
  */
  it.each([
    'function decorate(...args:unknown[]){}export abstract class Local {@decorate abstract [XMLHttpRequest.DONE]:string;}',
    'function decorate(...args:unknown[]){}export abstract class Local {@decorate abstract [globalThis.XMLHttpRequest.DONE]:string;}',
    'function decorate(...args:unknown[]){}export abstract class Local {@decorate abstract accessor [XMLHttpRequest.DONE]:string;}',
    'export abstract class Local {@((target:object,key:string|symbol)=>{console.log(typeof XMLHttpRequest);}) abstract [4]:string;}',
  ])('retains legacy abstract decorator evaluation: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Exported nested namespaces containing only types emit no value binding.
  Their outer name must therefore still resolve to the browser global.
  Breaking recursion through exported declarations hides these real calls.
  */
  it.each([
    'namespace window {export namespace Types {export type Marker=string;}} window.fetch("/items"); export {};',
    'namespace window {export namespace Types {export interface Marker {}}} window.fetch("/items"); export {};',
  ])('retains the runtime global beside nested erased namespaces: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  An actual parameter binding takes precedence over an Annex B binding in
  the outer CommonJS scope. Its globalThis default remains a native root,
  including through an alias; checking hoisted names first misses each call.
  */
  it.each([
    '{function window(){}} function use(window=globalThis){window.fetch("/items");}',
    '{function window(){}} const use=(window=globalThis)=>{window.fetch("/items");};',
    '{function window(){}} function use(window=globalThis){const native=window;native.fetch("/items");}',
  ])('prefers the resolved parameter over an outer Annex B binding: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Configured globals have no local definitions and cannot override Annex B
  function bindings. Both role lookup and constant evaluation must use the
  local function; treating the predefined global as resolved creates errors.
  */
  it.each([
    '{function fetch(){return "local";}} fetch("/items");',
    '{function String(){return "setTimeout";}} console.log(typeof globalThis[String("fetch")]);',
  ])('lets an Annex B binding shadow configured globals: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs', [
      { languageOptions: { globals: { fetch: 'readonly', String: 'readonly' } } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  Annex B applies to switch case functions as well as block functions.
  Omitting switch scopes invents native fetch access after the switch,
  whether or not the consumer explicitly configures a fetch global.
  */
  it.each([false, true])(
    'retains switch Annex B bindings with configured fetch=%s',
    async (configured) => {
      const result = await lint(
        'switch(0){case 0:function fetch(){return "local";}} fetch("/items");',
        'src/client.cjs',
        configured ? [{ languageOptions: { globals: { fetch: 'readonly' } } }] : [],
      );
      expect(result.messages).toEqual([]);
    },
  );

  /**
  A with environment affects outer lookup, not lexical bindings declared
  inside it. Imported HTTP callback parameters and awaited local constants
  retain their known origin; crossing their scope boundary hides real calls.
  */
  it.each([
    'with({}){import("node:http").then(http=>http.request("/items"));}',
    'with({}){import("node:http").then(function use(http){http.get("/items");});}',
    'async function use(){with({}){const http=await import("node:http");http.request("/items");}}',
  ])('retains lexical HTTP bindings inside with: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  A var initializer inside with assigns through its dynamic environment.
  The object can receive the value while the hoisted function binding stays
  undefined. Later reads and aliases must not inherit that initializer's
  module provenance, including destructuring and pending import callbacks.
  */
  it.each([
    "async function use(){with({http:{request(){}}}){var http=await import('node:http');}console.log(typeof http?.request);}use();",
    "async function use(){with({http:{request(){}}}){var http=await import('node:http');}const alias=http;console.log(typeof alias?.request);}use();",
    "async function use(){with({http:{request(){}}}){var {default:http}=await import('node:http');}console.log(typeof http?.request);}use();",
    "with({pending:{then(){}}}){var pending=import('node:http');}pending?.then(http=>console.log(typeof http.request));",
    "with({pending:{then(){}}}){var pending=import('node:http');}const alias=pending;alias?.then(http=>console.log(typeof http.request));",
  ])('does not trust dynamically intercepted var initializers: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([]);
  });

  /**
  Let and const declarations create lexical bindings inside with rather than
  assigning through its object. Their namespaces remain known in nested
  callbacks as well as direct reads, even when the object has the same key.
  Ordinary var declarations outside with remain known too.
  */
  it.each([
    "async function use(){with({http:{request(){}}}){let http=await import('node:http');http.request('/items');}}",
    "async function use(){with({http:{request(){}}}){const {default:http}=await import('node:http');(()=>http.request('/items'))();}}",
    "with({pending:{then(){}}}){const pending=import('node:http');pending.then(http=>http.request('/items'));}",
    "async function use(){var http=await import('node:http');http.request('/items');}",
  ])('retains bindings whose initializers cannot be intercepted: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Sloppy for-in permits a var initializer, then overwrites its binding with
  each property name. ESLint marks both writes as init=true, so treating all
  initialization writes as immutable fabricates a native member access on a
  string. The overwrite also invalidates later reads and nested aliases.
  */
  it.each([
    'for(var root=globalThis in {local:1}){console.log(typeof root.fetch);}',
    'for(var root=globalThis in {local:1}){}console.log(typeof root.fetch);',
    'function use(){for(var root=globalThis in {local:1}){const alias=root;console.log(typeof alias.fetch);}}',
    "for(var http=require('node:http') in {local:1}){console.log(typeof http.request);}",
    "for(var http=require('node:http') in {local:1}){}console.log(typeof http.get);",
  ])('does not retain an initializer overwritten by for-in: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([]);
  });

  /**
  Ordinary for initializers do not receive iteration values. Destructuring
  defaults may also have several init=true writes without any reassignment.
  Those aliases, roots outside an unrelated loop, and native references
  acquired by a legacy for-in initializer must remain detectable.
  */
  it.each([
    'for(var root=globalThis;;){console.log(typeof root.fetch);break;}',
    "for(var {default:root=globalThis}=require('node:http');;){console.log(typeof root.fetch);break;}",
    'const root=globalThis;for(var key in {local:1}){console.log(typeof root.fetch);}',
    'for(var send=fetch in {local:1}){console.log(typeof send);}',
    "for(var send=require('node:http').request in {local:1}){console.log(typeof send);}",
  ])('retains native acquisition beside loop initialization: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  A simple catch parameter can share its name with a hoisted var declaration.
  The initializer then writes to the catch parameter while the outer var
  stays undefined. Its later reads, aliases and optional Promise callbacks
  must not inherit the catch binding's initializer.
  */
  it.each([
    'try{throw 0;}catch(root){var root=globalThis;}console.log(typeof root?.fetch);',
    'try{throw 0;}catch(root){var root=globalThis;}const alias=root;console.log(typeof alias?.fetch);',
    "try{throw 0;}catch(http){var http=require('node:http');}console.log(typeof http?.request);",
    "try{throw 0;}catch(pending){var pending=import('node:http');}pending?.then(http=>console.log(typeof http.request));",
  ])('does not reuse an initializer assigned to a catch parameter: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([]);
  });

  /**
  A catch parameter only intercepts assignments to its own name. Earlier
  outer aliases, different var names and lexical bindings in the body keep
  their runtime values. Native references in an intercepted initializer are
  still acquisitions even though its outer var receives no value.
  */
  it.each([
    'var root=globalThis;try{throw 0;}catch(root){}console.log(typeof root.fetch);',
    'try{throw 0;}catch(error){var root=globalThis;}console.log(typeof root.fetch);',
    'try{throw 0;}catch(root){const local=globalThis;console.log(typeof local.fetch);}',
    'try{throw 0;}catch(send){var send=fetch;}console.log(typeof send);',
    "try{throw 0;}catch(send){var send=require('node:http').request;}console.log(typeof send);",
  ])('retains independent native acquisition beside catch parameters: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Type and value declarations can share one name. An export of that name
  exposes its actual HTTP module value, regardless of declaration order.
  Preserving a mixed binding merely because one definition is erased loses
  this export; only bindings whose every definition is type-only qualify.
  */
  it.each([
    'type http=string; const http=require("node:http"); export {http};',
    'const http=require("node:http"); type http=string; export {http};',
  ])('retains exported values with a same-name type: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });
});
