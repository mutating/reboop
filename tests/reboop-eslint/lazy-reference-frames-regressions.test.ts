import { ESLint } from 'eslint';
import type { Rule, Scope } from 'eslint';
import { expect, it, vi } from 'vitest';
import plugin from '../../packages/reboop-eslint/src/index.js';

/**
Ordinary property names never ask the constant evaluator to resolve a binding.
Observe allocations inheriting the actual rule root: one evaluator root is
allowed, but eagerly building a frame per reference wastes work in every file.
A native fetch diagnostic also ensures skipping the rule cannot meet the budget.
*/
it('does not allocate reference frames for ordinary property names', async () => {
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
    const properties = Array.from(
      { length: 256 },
      (_, index) => `const result${String(index)}=local.value;`,
    ).join('');
    const [result] = await eslint.lintText(
      `const local={value:1};${properties}globalThis.fetch('/api');`,
      { filePath: 'src/client.js' },
    );
    expect(root).toBeDefined();
    expect(result?.messages).toEqual([
      expect.objectContaining({ ruleId: 'reboop/require-client' }),
    ]);
    expect(
      create.mock.calls.filter(([prototype]) => (prototype as unknown) === root).length,
    ).toBeLessThanOrEqual(1);
  } finally {
    create.mockRestore();
  }
});
