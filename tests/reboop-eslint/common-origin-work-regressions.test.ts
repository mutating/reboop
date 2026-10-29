import { ESLint } from 'eslint';
import type { Rule, Scope } from 'eslint';
import { expect, it, vi } from 'vitest';
import plugin from '../../packages/reboop-eslint/src/index.js';

/**
An unknown first branch already makes the common origin unknown. Resolving the
fallback namespace cannot add information and unnecessarily normalizes another
binding. Count only Object.create calls for the real imported scope variable;
no elapsed-time assertion depends on machine speed. Each operator row rejects
eager fallback resolution, checks that an independently visited native RHS still
reports, and requires two agreeing known branches to retain their transport. Distinct
known modules retain only shared fields, never HTTP-only ClientRequest.
*/
it.each([
  {
    name: 'logical expressions',
    unknown: 'const custom={};const chosen=custom||fallback;chosen.request;',
    native: 'const direct=custom||globalThis.fetch;direct();',
    known: 'const chosen=fallback||fallback;chosen.request;',
    mixed: 'const chosen=fallback||other;chosen.ClientRequest;',
  },
  {
    name: 'conditional expressions',
    unknown: 'const custom={};const chosen=true?custom:fallback;chosen.request;',
    native: 'const direct=true?custom:globalThis.fetch;direct();',
    known: 'const chosen=true?fallback:fallback;chosen.request;',
    mixed: 'const chosen=true?fallback:other;chosen.ClientRequest;',
  },
  {
    name: 'logical assignment expressions',
    unknown: 'let custom={};const chosen=(custom||=fallback);chosen.request;',
    native: 'const direct=(custom||=globalThis.fetch);direct();',
    known: 'const chosen=(fallback.default||=fallback.default);chosen.request;',
    mixed: 'const chosen=(fallback.default||=other.default);chosen.ClientRequest;',
  },
])(
  'does not resolve irrelevant fallback origins in $name',
  async ({ unknown, native, known, mixed }) => {
    let fallback: Scope.Variable | undefined;
    const probe: Rule.RuleModule = {
      meta: { schema: [] },
      create(context) {
        fallback = context.sourceCode.scopeManager.scopes
          .flatMap((scope) => scope.variables)
          .find((variable) => variable.name === 'fallback');
        return {};
      },
    };
    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: [
        {
          plugins: { probe: { rules: { binding: probe } } },
          rules: { 'probe/binding': 'error' },
        },
        plugin.configs.recommended,
      ],
    });
    const prefix = "import * as fallback from 'node:http';\n";
    const code = `${prefix}${unknown}\n${native}`;
    const create = vi.spyOn(Object, 'create');
    try {
      const [result] = await eslint.lintText(code, { filePath: 'src/client.js' });
      expect(fallback).toBeDefined();
      expect(result?.fatalErrorCount).toBeLessThanOrEqual(0);
      expect(result?.messages).toEqual([
        expect.objectContaining({
          ruleId: 'reboop/require-client',
          line: 3,
          column: native.indexOf('globalThis.fetch') + 1,
        }),
      ]);
      expect(
        create.mock.calls.filter(([prototype]) => (prototype as unknown) === fallback).length,
      ).toBeLessThanOrEqual(0);
    } finally {
      create.mockRestore();
    }
    const [result] = await eslint.lintText(`${prefix}${known}`, { filePath: 'src/client.js' });
    expect(result?.fatalErrorCount).toBeLessThanOrEqual(0);
    expect(result?.messages).toEqual([
      expect.objectContaining({
        ruleId: 'reboop/require-client',
        line: 2,
        column: known.indexOf('chosen.request') + 1,
      }),
    ]);
    const [intersection] = await eslint.lintText(
      `${prefix}import * as other from 'node:https';\n${mixed}`,
      { filePath: 'src/client.js' },
    );
    expect(intersection?.fatalErrorCount).toBeLessThanOrEqual(0);
    expect(intersection?.messages).toEqual([]);
  },
);
