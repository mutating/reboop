import { parser } from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

describe('TypeScript parameter property regressions', () => {
  /**
  Parameter-property modifiers preserve a constructor's ordinary runtime
  parameter and its default initializer. They must not hide a known transport
  origin when the parameter is read directly or through an immutable alias.
  The cases cover every modifier, combined modifiers, type erasure, Node
  namespaces and a constructed undici dispatcher rather than following fields.
  */
  it.each([
    "class Client { constructor(public root=globalThis) { root.fetch('/items'); } }",
    "class Client { constructor(private root=globalThis) { root.fetch('/items'); } }",
    "class Client { constructor(protected root=globalThis) { root.fetch('/items'); } }",
    "class Client { constructor(readonly root=globalThis) { root.fetch('/items'); } }",
    "class Client { constructor(public readonly root=globalThis) { root.fetch('/items'); } }",
    "class Client { constructor(private readonly root:typeof globalThis=globalThis) { root['fetch']('/items'); } }",
    "const native=globalThis;class Client { constructor(protected readonly root=native) { const alias=root;alias.fetch('/items'); } }",
    "class Client { constructor(public root=window) { const {fetch:send}=root;send('/items'); } }",
    "class Client { constructor(public root=require('node:http')) { root.request('/items'); } }",
    "import * as native from 'node:https';class Client { constructor(private root=native) { root.get('/items'); } }",
    "import {Agent} from 'undici';class Client { constructor(readonly root=new Agent()) { root.request('/items'); } }",
  ])('retains a modified parameter default origin: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  A modifier does not make an unknown argument native or turn a class field
  into a tracked parameter read. Local shadowing, custom defaults, later writes
  and branches without an agreed origin remain unknown, including the bare
  Identifier form of a parameter property without any initializer.
  */
  it.each([
    "class Client { constructor(public root:typeof globalThis) { root.fetch('/items'); } }",
    "class Client { constructor(private root=custom) { root.fetch('/items'); } }",
    "class Client { constructor(protected window=custom) { window.fetch('/items'); } }",
    "class Client { constructor(readonly fetch=custom) { fetch('/items'); } }",
    "const globalThis=custom;class Client { constructor(public root=globalThis) { root.fetch('/items'); } }",
    "class Client { constructor(public root=globalThis) { root=custom;root.fetch('/items'); } }",
    "class Client { constructor(public root=enabled?globalThis:custom) { root.fetch('/items'); } }",
    "class Client { constructor(public root=globalThis) { this.root.fetch('/items'); } }",
  ])('preserves unknown and shadowed parameter origins: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });
});
