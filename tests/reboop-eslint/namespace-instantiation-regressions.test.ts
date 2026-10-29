import { parser } from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

const prelude =
  'export{};declare function consume(value:unknown):void;declare const custom:any;declare namespace Types{interface T{}class C{}}';

describe('namespace instantiation and internal import aliases', () => {
  /**
  A namespace containing only private import aliases and erased type members
  is not instantiated. It cannot hide an existing native/global-object alias,
  loader or publicly forwarded HTTP namespace. All supported emitters erase
  these namespaces, including when the unused import aliases a value class.
  The alias definitions themselves must stay available in runtime namespaces.
  */
  it.each(
    [
      'const root=globalThis;namespace root{import T=Types.T;}consume(root.fetch);',
      'const root=globalThis;namespace root{import T=Types.C;}consume(root.XMLHttpRequest);',
      'const root=globalThis;namespace root{import Local=root;}consume(root.fetch);',
      'namespace fetch{import T=Types.T;}consume(fetch);',
      'namespace XMLHttpRequest{import T=Types.T;}consume(XMLHttpRequest);',
      'namespace window{import T=Types.T;}consume(window.fetch);',
      'const root=globalThis;namespace Outer{namespace root{import T=Types.T;}consume(root.fetch);}',
      'const root=globalThis;namespace root.Inner{import T=Types.T;}consume(root.fetch);',
      'const root=globalThis;namespace root{import T=Types.T;interface U{}export type V=T;}consume(root.fetch);',
      "import * as http from 'node:http';const root=http;namespace root{import T=Types.T;}consume(root.request);",
      "import * as http from 'node:http';const root=http;namespace root{import T=Types.T;}export{root};",
      "import{createRequire}from'node:module';const require=createRequire('/app/client.cjs');namespace require{import T=Types.T;}require('axios');",
      'const root=globalThis;namespace root{import T=Types.T;}class C{@(root.fetch as any)declare value:string;}',
      'namespace N{import root=globalThis;consume(root.fetch);}',
      'import root=globalThis;consume(root.fetch);',
      "import * as http from 'node:http';namespace N{export import Request=http.ClientRequest;}",
      "import * as http from 'node:http';namespace N{export import API=http;}",
    ].map((code, caseIndex) => ({ code: prelude + code, caseIndex })),
  )('retains runtime transport origin in case $caseIndex', async ({ code }) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Private imports inside a completely erased namespace do not evaluate their
  qualified names. Rejecting an unused ClientRequest/fetch alias would invent
  an acquisition, even though its source module or global contains HTTP APIs.
  Ambient and bodyless module declarations retain the same erasure protection.
  */
  it.each(
    [
      "import * as http from 'node:http';namespace N{import Request=http.ClientRequest;}",
      'namespace N{import Request=globalThis.XMLHttpRequest;}',
      'namespace N{import Send=globalThis.fetch;}',
      'declare namespace N{import Send=globalThis.fetch;}',
      "declare module 'safe-client';",
    ].map((code, caseIndex) => ({
      code: code.startsWith('declare module ') ? code : prelude + code,
      caseIndex,
    })),
  )('allows erased namespace import expression in case $caseIndex', async ({ code }) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  Exported import aliases and other runtime statements still instantiate a
  namespace, so they introduce actual local objects rather than reveal native
  globals. Erasing an unrelated namespace also must not replace a surviving
  custom lexical client or loader with a same-name native capability.
  */
  it.each(
    [
      'namespace window{export import T=Types.C;}consume((window as any).fetch);',
      'namespace window{import T=Types.T;;}consume((window as any).fetch);',
      'namespace window{import T=Types.T;export const version=1;}consume((window as any).fetch);',
      'const fetch=custom;namespace fetch{import T=Types.T;}consume(fetch);',
      'const require=custom;namespace require{import T=Types.T;}require("axios");',
      'namespace Outer{const window=custom;namespace window{import T=Types.T;}consume(window.fetch);}',
    ].map((code, caseIndex) => ({ code: prelude + code, caseIndex })),
  )('preserves instantiated or custom namespace binding in case $caseIndex', async ({ code }) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });
});
