import { parser } from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

describe('decorated declared member runtime references', () => {
  /**
  A declared property in a runtime class erases its storage, but legacy
  TypeScript decorators still evaluate and emit their expressions. Ambient
  member syntax must not hide native references used by those decorators.
  Global names, static/readonly members, aliases and runtime namespaces all
  retain the same acquisition policy as an ordinary decorated field.
  */
  it.each(
    [
      'class C { @(globalThis.fetch as any) declare field: string; }',
      'class C { @(fetch as any) declare field: string; }',
      'class C { @(globalThis.XMLHttpRequest as any) declare static field: string; }',
      'class C { @(XMLHttpRequest as any) declare field: string; }',
      'const root=globalThis;class C { @(root.fetch as any) declare field: string; }',
      'const root=window;class C { @(root.XMLHttpRequest as any) declare readonly field: string; }',
      'declare function factory(value:unknown):any;class C { @factory(globalThis.fetch) declare field: string; }',
      'namespace N { export class C { @(globalThis.fetch as any) declare field: string; } }',
      'abstract class C { @(globalThis.fetch as any) declare field: string; }',
    ].map((code, caseIndex) => ({ code, caseIndex })),
  )('rejects runtime decorator acquisition $caseIndex: $code', async ({ code }) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  The containing class or namespace can erase the entire decorated member.
  TypeScript emits no decorator expression for those ambient ancestors.
  Undecorated declared members and type queries are also erased, while local
  decorator values keep their lexical binding instead of matching by name.
  These controls prevent fixing a member exception by dropping all declare
  barriers or treating every decorator spelling as a native acquisition.
  */
  it.each(
    [
      'declare class C { @(globalThis.fetch as any) field: string; }',
      'declare class C { @(globalThis.fetch as any) declare field: string; }',
      'declare namespace N { class C { @(globalThis.fetch as any) field: string; } }',
      'declare namespace N { class C { @(globalThis.fetch as any) declare field: string; } }',
      'class C { declare field: typeof globalThis.fetch; }',
      'declare function noop(...args:any[]):any;class C { @noop declare field:typeof globalThis.fetch; }',
      'declare const local:any;class C { @local declare field: string; }',
      'declare const local:any;function use(){const fetch=local;class C { @fetch declare field: string; }}use();',
      'function use(globalThis:any) { class C { @(globalThis.fetch as any) declare field:string; } }',
      'declare const custom:any;const root=custom;class C { @(root.fetch as any) declare field:string; }',
    ].map((code, caseIndex) => ({ code, caseIndex })),
  )('allows erased or local decorator value $caseIndex: $code', async ({ code }) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  Declaring the entire class erases its class-level decorator as well as
  the class body. The runtime exception for decorated declared fields must
  require a field node, rather than match any declared node with decorators.
  TypeScript accepts these inputs and emits no native reference for them.
  */
  it.each(
    [
      '@(globalThis.fetch as any) declare class C {}',
      '@(fetch as any) declare class C {}',
      '@(globalThis.XMLHttpRequest as any) declare class C {}',
      'const root=globalThis;@(root.fetch as any) declare class C {}',
    ].map((code, caseIndex) => ({ code, caseIndex })),
  )('erases an ambient class decorator $caseIndex: $code', async ({ code }) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  An undecorated declared field erases its computed key expression. Entity
  names such as fetch.name are valid string keys in TypeScript, but the
  emitted class never reads fetch. Requiring an actual decorator prevents
  treating every declared field key as a runtime acquisition.
  */
  it.each(
    [
      'class C { declare [globalThis.fetch.name]: string; }',
      'class C { declare [fetch.name]: string; }',
      'class C { declare [globalThis.XMLHttpRequest.name]: string; }',
      'class C { declare [XMLHttpRequest.name]: string; }',
      'const root=globalThis;class C { declare [root.fetch.name]: string; }',
    ].map((code, caseIndex) => ({ code, caseIndex })),
  )('erases an undecorated declared key $caseIndex: $code', async ({ code }) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });
});
