import { ESLint } from 'eslint';
import type { Rule, Scope } from 'eslint';
import { expect, it, vi } from 'vitest';
import plugin from '../../packages/reboop-eslint/src/index.js';

/**
A property selected from an unknown receiver has no known origin, regardless of
its computed name. Resolving that name still allocates constant-evaluator frames
for the entire file. Count allocations inheriting the actual evaluator root:
only the root itself is needed. The three rows independently reach member
resolution, the Property visitor and nested pattern-origin selection. Native
references inside skipped computed keys must retain their own diagnostics;
known receivers must still evaluate the key and report the selected transport.
*/
it.each([
  {
    name: 'member expressions',
    unknown: "const key='value';const source={};source[key];source[globalThis.fetch];",
    known: "const key='fetch';globalThis[key];",
    selected: 'globalThis[key]',
  },
  {
    name: 'destructured properties',
    unknown:
      "const key='value';const source={};const {[key]:first,[globalThis.fetch]:second}=source;",
    known: "const key='fetch';const {[key]:value}=globalThis;",
    selected: '[key]',
  },
  {
    name: 'nested pattern origins',
    unknown:
      "const key='value';const source={};const {[key]:{first},[globalThis.fetch]:{second}}=source;",
    known: "const key='window';const {[key]:{fetch:value}}=globalThis;",
    selected: 'fetch:value',
  },
])('does not evaluate unknown computed $name', async ({ unknown, known, selected }) => {
  let root: Scope.Scope | undefined;
  const probe: Rule.RuleModule = {
    meta: { schema: [] },
    create(context) {
      root = context.sourceCode.getScope(context.sourceCode.ast);
      return {};
    },
  };
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        plugins: { probe: { rules: { root: probe } } },
        rules: { 'probe/root': 'error' },
      },
      plugin.configs.recommended,
    ],
  });
  const create = vi.spyOn(Object, 'create');
  try {
    const [result] = await eslint.lintText(unknown, {
      filePath: 'src/client.js',
    });
    expect(root).toBeDefined();
    expect(result?.fatalErrorCount).toBe(0);
    expect(result?.messages).toEqual([
      expect.objectContaining({
        ruleId: 'reboop/require-client',
        column: unknown.indexOf('globalThis.fetch') + 1,
      }),
    ]);
    expect(
      create.mock.calls.filter(([prototype]) => (prototype as unknown) === root).length,
    ).toBeLessThanOrEqual(1);
  } finally {
    create.mockRestore();
  }
  const [result] = await eslint.lintText(known, {
    filePath: 'src/client.js',
  });
  expect(result?.fatalErrorCount).toBe(0);
  expect(result?.messages).toEqual([
    expect.objectContaining({
      ruleId: 'reboop/require-client',
      column: known.indexOf(selected) + 1,
    }),
  ]);
});
