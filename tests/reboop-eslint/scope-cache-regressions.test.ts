import { ESLint } from 'eslint';
import type { Rule } from 'eslint';
import { describe, expect, it } from 'vitest';
import plugin from '../../packages/reboop-eslint/src/index.js';
import { lint } from './lint.js';

/**
Count semantic write queries, rather than elapsed time, to avoid CI noise.
*/
async function countedLint(code: string): Promise<{
  result: ESLint.LintResult;
  referenceCount: number;
  writeChecks: number;
}> {
  let referenceCount = 0;
  let writeChecks = 0;
  const probe: Rule.RuleModule = {
    meta: { schema: [] },
    create(context) {
      const root = context.sourceCode.scopeManager.scopes
        .flatMap((scope) => scope.variables)
        .find((variable) => variable.name === 'root');
      if (root === undefined) {
        throw new Error('Expected the root binding');
      }
      referenceCount = root.references.length;
      for (const reference of root.references) {
        const isWrite = reference.isWrite.bind(reference);
        reference.isWrite = (): boolean => {
          writeChecks += 1;
          return isWrite();
        };
      }
      return {};
    },
  };
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        plugins: { probe: { rules: { count: probe } }, reboop: plugin },
        rules: { 'probe/count': 'error', 'reboop/require-client': 'error' },
      },
    ],
  });
  const [result] = await eslint.lintText(code, { filePath: 'src/client.js' });
  if (result === undefined) {
    throw new Error('Expected ESLint to process the source');
  }
  return { result, referenceCount, writeChecks };
}

describe('scope normalization cache regressions', () => {
  /**
  Repeated reads of one immutable binding must not rescan all its references for
  every AST node. Both normalized-view reuse and write-result reuse are needed
  to keep the deterministic query budget linear. Every native access must still
  be reported, so skipping analysis cannot satisfy the performance assertion.
  Bypassing either cache makes this test exceed the bound by an order of magnitude.
  */
  it('keeps write queries linear for repeated native accesses', async () => {
    const count = 96;
    const { result, referenceCount, writeChecks } = await countedLint(
      `const root=globalThis;${'root.fetch;'.repeat(count)}`,
    );
    expect(result.fatalErrorCount).toBe(0);
    expect(result.messages).toHaveLength(count);
    expect(result.messages.every((message) => message.ruleId === 'reboop/require-client')).toBe(
      true,
    );
    expect(writeChecks).toBeLessThanOrEqual(referenceCount * 3);
  });

  /**
  An inner parameter and an outer variable can share a name while denoting
  different clients. Normalized views must be keyed by binding identity rather
  than text; sharing the outer native view would falsely diagnose the local
  parameter access in addition to the one real native access.
  */
  it('keeps normalized views separate for same-name bindings', async () => {
    const result = await lint(
      'const root=globalThis;function use(root={fetch(){}}){root.fetch;}root.fetch;',
    );
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  The stable outer client and reassigned inner native alias have opposite write
  histories despite sharing a name. Caching reassignment by name would reuse
  the outer false result and fabricate a native access after the inner write.
  */
  it('keeps write histories separate for same-name bindings', async () => {
    const result = await lint(
      'const root={fetch(){}};function use(){let root=globalThis;root={fetch(){}};root.fetch;}root.fetch;',
    );
    expect(result.messages).toEqual([]);
  });

  /**
  The immutable snapshot must be built only after collecting all references.
  A write appearing later in the file invalidates the alias even when its first
  read precedes that write. Priming the cache during the reference prepass would
  retain an incomplete write list and falsely diagnose the final local client.
  */
  it('includes later writes before caching the normalized binding', async () => {
    const result = await lint('let root=globalThis;root.console;root={fetch(){}};root.fetch;');
    expect(result.messages).toEqual([]);
  });
});
