import { parser } from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

describe('destructured public namespace forwarding', () => {
  /**
  Destructuring can assign a known HTTP namespace directly into a public
  CommonJS export. Changing the assignment syntax must not hide forwarding,
  including static computed targets, unchanged public aliases and branches
  whose namespaces agree on HTTP methods. No object mutation is inferred.
  */
  it.each([
    "({default:module.exports}=await import('node:http'));",
    "({default:exports.client}=await import('node:https'));",
    "({default:module['exports'].client}=await import('node:http'));",
    "({['default']:module.exports}=await import('undici'));",
    "const target=module.exports;({default:target.client}=await import('node:http'));",
    "const pending=import('node:https');const ns=await pending;({default:module.exports}=ns);",
    "const ns=flag?await import('node:http'):await import('node:https');({default:exports.client}=ns);",
    "({default:module.exports=fallback}=await import('node:http'));",
    "const target=exports;({default:target.client=fallback}=await import('node:https'));",
  ])('rejects direct public namespace forwarding: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  A modeled absent field activates its destructuring default. Nested defaults
  may therefore select another known namespace before assigning the public
  leaf. The original property or outer pattern alone cannot describe the
  exported value; field selection and default evaluation must stay shared.
  */
  it.each([
    "({default:module.exports=require('node:https')}=require('node:http'));",
    "({default:{default:module.exports=require('node:https')}}=await import('node:http'));",
    "({default:{default:exports.client=require('node:http')}}=await import('node:https'));",
    "const target=exports;({default:{default:target.client=require('undici')}}=await import('node:http'));",
  ])('rejects public namespace forwarding through defaults: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  ESM destructured declarations already expose their known namespace through
  the exported binding. Retain both immediate and later named exports while
  sharing the field/default resolver with CommonJS destructuring targets.
  */
  it.each([
    "export const {default:client}=await import('node:http');",
    "const {default:client}=await import('node:https');export {client};",
    "export const {default:client=require('node:https')}=require('node:http');",
    "const {default:{default:client=require('node:http')}}=await import('node:https');export {client};",
  ])('retains exported destructured ESM bindings: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Namespace storage is allowed while it stays local or its selected value
  is absent/unknown. A matching target spelling is insufficient: local module
  and exports bindings, private fields and unknown computed keys are not
  proven public export slots. Unknown fields cannot activate guessed defaults.
  */
  it.each([
    "let client;({default:client}=await import('node:http'));",
    "let client;({default:client=require('node:https')}=require('node:http'));",
    "({default:module.exports}=await import('node:url'));",
    "({default:module.exports}=require('node:http'));",
    "({default:{default:module.exports}}=await import('node:http'));",
    "({unknown:module.exports=require('node:http')}=require('node:https'));",
    "({default:module.exports}=await import('./local-client.js'));",
    "const module={exports:{}};({default:module.exports}=await import('node:http'));",
    "const exports={};({default:exports.client}=await import('node:https'));",
    "function keep(module){return import('node:http').then(ns=>{({default:module.exports}=ns);});}",
    "const key=getKey();({default:module[key]}=await import('node:http'));",
    "({default:module['private']}=await import('node:https'));",
    "class Box{#client;async save(){({default:this.#client}=await import('node:http'));}}",
  ])('allows private, local, absent or unknown storage: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });

  /**
  Erased TS expression wrappers around public targets retain the same runtime
  export slot. Keep the TypeScript parser path consistent with JavaScript
  destructuring rather than relying on unwrapped target spelling.
  */
  it.each([
    "({default:(module.exports as unknown)}=await import('node:http'));",
    "({default:(exports.client!)}=await import('node:https'));",
  ])('rejects wrapped TypeScript public targets: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });
});
