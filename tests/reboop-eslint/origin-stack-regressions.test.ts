import { parser } from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

describe('origin recursion stack regressions', () => {
  /**
  An unchanged alias can supply both a destructuring input and a statically
  activated default. Earlier completed lookups must not count as recursion:
  repeated module, namespace, global-object, loader and callback origins still
  acquire the same native transport. Sibling and nested defaults additionally
  protect against leaking a visited node from one independent branch to another.
  TypeScript aliases use any annotations so its builtin module declarations do
  not reject a default for a field known to be absent at runtime.
  */
  it.each(
    (
      [
        [
          "const seed=require('node:http');const {default:root=seed}=seed;consume(root.request);",
          'commonjs',
        ],
        [
          "const seed=require('node:https');const {default:root=seed}=seed;consume(root.get);",
          'commonjs',
        ],
        [
          "import http from 'node:http';const seed=http;export const {default:root=seed}=seed;",
          'module',
        ],
        [
          "const seed=(await import('node:http')).default;const {default:root=seed}=seed;consume(root.request);",
          'module',
        ],
        [
          "const seed=require('node:http');const {default:left=seed,default:root=seed}=require('node:http');consume(root.request);",
          'commonjs',
        ],
        [
          "const seed=globalThis;const {default:left=seed,default:root=seed}=require('node:http');consume(root.fetch);",
          'commonjs',
        ],
        [
          "const {createRequire}=require('node:module');const load=createRequire('/app/client.cjs');const {default:root=load('node:http')}=load('node:http');consume(root.request);",
          'commonjs',
        ],
        [
          "const seed=flag?require('node:http'):require('node:https');const {default:root=seed}=seed;consume(root.request);",
          'commonjs',
        ],
        [
          "const seed=require('node:http');const {default:{default:root=seed}=seed}=seed;consume(root.request);",
          'commonjs',
        ],
        [
          "const pending=import('node:http');pending.then(ns=>{const seed=ns.default;const {default:root=seed}=seed;consume(root.request);});",
          'commonjs',
        ],
        [
          "const pending=import('node:http');pending.then(({default:seed})=>{const {default:root=seed}=seed;consume(root.request);});",
          'commonjs',
        ],
        [
          "const seed=await import('node:http');const {default:root=custom}=seed;consume(root.request);",
          'module',
        ],
        [
          "const seed=require('node:http');const {default:root=seed}=require('node:http');consume(root.request);",
          'commonjs',
        ],
      ] as const
    ).flatMap(([code, sourceType], caseIndex) =>
      ['js', 'ts'].map((extension) => ({
        code:
          extension === 'ts'
            ? code
                .replaceAll('const seed=', 'const seed:any=')
                .replace('({default:seed})', '({default:seed}:any)')
            : code,
        sourceType,
        caseIndex,
        extension,
      })),
    ),
  )(
    'retains a completed origin in case $caseIndex ($extension)',
    async ({ code, sourceType, extension }) => {
      const result = await lint(code, `src/client.${extension}`, [
        {
          files: ['**/*.js', '**/*.ts'],
          languageOptions: { ...(extension === 'ts' && { parser }), sourceType },
        },
      ]);
      expect(result.messages).toEqual([
        expect.objectContaining({ ruleId: 'reboop/require-client' }),
      ]);
    },
  );

  /**
  Actual recursive bindings remain unknown and must terminate. Cleaning a
  completed lookup must not turn a genuine active cycle into a known origin,
  activate defaults for unknown fields, revive reassigned sources, or infer
  transports from custom clients and locally shadowed loaders.
  A recursive destructuring default revisits its target after a completed
  source lookup; clearing all ancestors there would allow unbounded recursion
  instead of preserving the active target's cycle guard.
  */
  it.each(
    [
      "var seed=seed;const {default:root=seed}=require('node:http');consume(root.request);",
      "var seed=other;var other=seed;const {default:root=seed}=require('node:http');consume(root.request);",
      "const seed=custom;const {default:root=require('node:http')}=seed;consume(root.request);",
      "const seed=custom;const {default:root=seed}=require('node:http');consume(root.request);",
      "const seed=require('node:http');const {default:root=custom}=seed;consume(root.request);",
      "let seed=require('node:http');const saved=seed;seed=custom;const {default:root=saved}=saved;consume(root.request);",
      "function use(require){const seed=require('node:http');const {default:root=seed}=seed;consume(root.request);}",
      "const seed=require('node:url');const {default:root=seed}=seed;consume(root.request);",
      "var {default:root=root}=require('node:http');consume(root.request);",
    ].flatMap((code, caseIndex) =>
      ['js', 'ts'].map((extension) => ({ code, caseIndex, extension })),
    ),
  )(
    'preserves unknown and cyclic inputs in case $caseIndex ($extension)',
    async ({ code, extension }) => {
      const result = await lint(code, `src/client.${extension}`, [
        {
          files: ['**/*.js', '**/*.ts'],
          languageOptions: { ...(extension === 'ts' && { parser }), sourceType: 'commonjs' },
        },
      ]);
      expect(result.messages).toEqual([]);
    },
  );
});
