import { parser } from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

describe('TypeScript overload signature erasure', () => {
  /**
  A function overload is a TSDeclareFunction even without an explicit declare
  modifier. Its binding-pattern keys are erased and never acquire transports.
  Strict TypeScript compilation and executing the emitted implementations with
  native getter counters confirmed zero reads for all fourteen fixtures. The
  cases protect direct and aliased Fetch/XHR, nested bindings, namespace methods,
  exports, async overloads and Node transport methods from false diagnostics.
  */
  it.each([
    'function use({[globalThis.fetch.name]:{value}}:any):any;function use(input:any){return input;}use({});',
    'function use({[fetch.name]:{value}}:any):any;function use(input:any){return input;}use({});',
    'function use({[globalThis.XMLHttpRequest.name]:{value}}:any):any;function use(input:any){return input;}use({});',
    'function use({[XMLHttpRequest.name]:{value}}:any):any;function use(input:any){return input;}use({});',
    'const root=globalThis;function use({[root.fetch.name]:{value}}:any):any;function use(input:any){return input;}use({});',
    'const root=globalThis;function use({[root.XMLHttpRequest.name]:{value}}:any):any;function use(input:any){return input;}use({});',
    'function use({wrapper:{[globalThis.fetch.name]:{value}}}:any):any;function use(input:any){return input;}use({});',
    'function use([{[globalThis.fetch.name]:{value}}]:any):any;function use(input:any){return input;}use([]);',
    'function use({[globalThis.fetch.name]:{[globalThis.XMLHttpRequest.name]:{value}}}:any):any;function use(input:any){return input;}use({});',
    'export function use({[globalThis.fetch.name]:{value}}:any):any;export function use(input:any){return input;}use({});',
    'async function use({[globalThis.fetch.name]:{value}}:any):Promise<any>;async function use(input:any){return input;}void use({});',
    'function outer(){function use({[globalThis.fetch.name]:{value}}:any):any;function use(input:any){return input;}return use({})}outer();',
    'namespace Local{export function use({[globalThis.fetch.name]:{value}}:any):any;export function use(input:any){return input;}}Local.use({});',
    "import * as http from 'node:http';function use({[http.request.name]:{value}}:any):any;function use(input:any){return input;}use({});",
  ])('erases a computed overload parameter key: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  An implementation is an ordinary FunctionDeclaration and evaluates binding
  keys and default values at runtime. Erasing every function-shaped node would
  hide real acquisitions, including an implementation following an overload.
  Exact diagnostic counts also ensure a native use beside an erased signature
  remains visible rather than erasing its sibling declaration or namespace.
  */
  it.each([
    'function use({[globalThis.fetch.name]:{value}}:any){return value;}',
    'function use({[fetch.name]:{value}}:any){return value;}',
    'function use({[globalThis.XMLHttpRequest.name]:{value}}:any){return value;}',
    'function use({[XMLHttpRequest.name]:{value}}:any){return value;}',
    'const root=globalThis;function use({[root.fetch.name]:{value}}:any){return value;}',
    'function use(input:any):any;function use({[globalThis.fetch.name]:{value}}:any){return value;}',
    'function use({[globalThis.fetch.name]:{value}}:any):any;function use(input:any){return globalThis.fetch;}',
    'namespace Local{export function use({[globalThis.fetch.name]:{value}}:any):any;export function use(input:any){return globalThis.fetch;}}',
    "import * as http from 'node:http';function use({[http.request.name]:{value}}:any){return value;}",
    'function use(input=globalThis.fetch){return input;}',
  ])('retains acquisition in a runtime implementation: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Explicit ambient declarations erase the same parameter syntax, while a local
  client keeps its own binding in both overload and implementation. These
  controls reject a spelling-based fix and preserve existing declare barriers,
  method overloads and declarations containing only native type queries.
  */
  it.each([
    'declare function use({[globalThis.fetch.name]:{value}}:any):any;',
    'declare namespace Local{function use({[globalThis.fetch.name]:{value}}:any):any;}',
    'const globalThis={fetch(){}};function use({[globalThis.fetch.name]:{value}}:any):any;function use({[globalThis.fetch.name]:{value}}:any){return value;}',
    'class Local{method({[globalThis.fetch.name]:{value}}:any):any;method(input:any){return input;}}',
    'function use(input:typeof globalThis.fetch):void;function use(input:unknown){return input;}',
  ])('preserves ambient and locally shadowed declarations: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });
});
