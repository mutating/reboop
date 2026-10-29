import { parser } from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

const loader =
  "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);const custom={};";

describe('canonical exported binding origins', () => {
  /**
  A catch-scoped var identifier can precede the exported declaration while
  still declaring the outer var. Looking up that identifier as an expression
  resolves the catch parameter, not the exported binding. Public namespace
  forwarding must use the actual exported symbol regardless of identifier
  order, catch initializers, loops, destructuring or bare redeclarations.
  These are valid ECMAScript modules; both parsers process the same JS source
  because TypeScript rejects mixing local and exported var modifiers in .ts.
  */
  it.each(
    [
      "try{throw null;}catch(ns){var ns;}export var ns=require('node:http');",
      "try{throw null;}catch(ns){var ns=custom;}export var ns=require('node:https');",
      "try{throw null;}catch(ns){for(var ns in {}){}}export var ns=require('node:http');",
      "try{throw null;}catch(ns){for(var ns of [custom]){}}export var ns=require('undici');",
      "try{throw null;}catch(ns){var ns;}export var {default:ns}=await import('node:http');",
      "try{throw null;}catch(ns){var ns;}const seed=require('node:http');export var {default:ns=seed}=seed;",
      "try{throw null;}catch(ns){var ns;}export var ns=require('node:http'),other=custom;",
      "try{throw null;}catch(ns){var ns;}try{throw null;}catch(ns){var ns=custom;}export var ns=require('node:http');",
      "try{throw null;}catch(ns){var ns;}var ns=require('node:http');export var ns;",
      "try{throw null;}catch(ns){var ns;}export var ns=(await import('node:http')).default;",
      "export var ns=require('node:http');try{throw null;}catch(ns){var ns=custom;}",
      "try{throw null;}catch(ns){var ns;}var ns=require('node:http');export{ns};",
      "try{throw null;}catch(ns){var ns;}export var ns=require('node:http').request;",
    ].flatMap((code, caseIndex) =>
      ['espree', 'typescript'].map((parserName) => ({ code, caseIndex, parserName })),
    ),
  )(
    'retains the exported namespace in case $caseIndex ($parserName)',
    async ({ code, parserName }) => {
      const result = await lint(loader + code, 'src/client.js', [
        { languageOptions: { ...(parserName === 'typescript' && { parser }) } },
      ]);
      expect(result.messages).toEqual([
        expect.objectContaining({ ruleId: 'reboop/require-client' }),
      ]);
    },
  );

  /**
  Canonical lookup must retain initializer ownership and write uncertainty.
  A catch-only initializer writes its local parameter, leaving the outer var
  unknown. Custom initializers, competing writes and unrelated private HTTP
  namespaces must not become public transport exports. Helper properties and
  unclassified loaders retain their existing non-transport classification.
  */
  it.each(
    [
      'try{throw null;}catch(ns){var ns;}export var ns=custom;',
      "try{throw null;}catch(ns){var ns;}var ns=require('node:http');ns=custom;export var ns;",
      "try{throw null;}catch(ns){var ns;}var ns=require('node:http');var ns=custom;export var ns;",
      "try{throw null;}catch(ns){var ns=require('node:http');}export var ns;",
      'try{throw null;}catch(ns){var ns;}export var ns;',
      "try{throw null;}catch(ns){var ns;}export var ns=require('node:url');",
      "const local=custom;try{throw null;}catch(ns){var ns;}export var ns=local('node:http');",
      "try{throw null;}catch(ns){var ns;}var ns=require('node:http');export var safe=custom;",
      "try{throw null;}catch(ns){var ns;}export var ns=require('node:http').Agent;",
      "try{throw null;}catch(ns){var ns;}export var ns={module:require('node:http')};",
    ].flatMap((code, caseIndex) =>
      ['espree', 'typescript'].map((parserName) => ({ code, caseIndex, parserName })),
    ),
  )(
    'preserves unknown or nontransport bindings in case $caseIndex ($parserName)',
    async ({ code, parserName }) => {
      const result = await lint(loader + code, 'src/client.js', [
        { languageOptions: { ...(parserName === 'typescript' && { parser }) } },
      ]);
      expect(result.messages).toEqual([]);
    },
  );

  /**
  Only variable declarations export their initializer's namespace directly.
  getDeclaredVariables(functionDeclaration) also returns private parameters,
  whose HTTP defaults do not turn a helper function into a namespace export.
  These bodies only read STATUS_CODES. Broadening the declaration-kind guard
  would reject ordinary, async and generator helpers, including later parameters.
  */
  it.each(
    [
      "import * as http from 'node:http';export function helper(client=http){return client.STATUS_CODES;}",
      "import * as http from 'node:http';export async function helper(client=http){return client.STATUS_CODES;}",
      "import * as http from 'node:http';export function* helper(client=http){yield client.STATUS_CODES;}",
      "import * as http from 'node:http';export function helper(status=200,client=http){return client.STATUS_CODES[status];}",
    ].flatMap((code, caseIndex) =>
      ['js', 'ts'].map((extension) => ({ code, caseIndex, extension })),
    ),
  )(
    'keeps private helper parameters in case $caseIndex ($extension)',
    async ({ code, extension }) => {
      const result = await lint(code, `src/client.${extension}`, [
        {
          files: ['**/*.js', '**/*.ts'],
          languageOptions: { ...(extension === 'ts' && { parser }) },
        },
      ]);
      expect(result.messages).toEqual([]);
    },
  );
});
