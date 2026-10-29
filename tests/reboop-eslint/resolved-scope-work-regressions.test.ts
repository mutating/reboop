import { ESLint } from 'eslint';
import type { Rule } from 'eslint';
import { expect, it } from 'vitest';
import plugin from '../../packages/reboop-eslint/src/index.js';

/**
With no hoisted block functions and no implicit arguments lookup, intermediate
scopes cannot supply a replacement binding. Resolving the same outer binding
must not walk those scopes again before examining its actual scope. Count real
upper-link reads, preserving every link. Allow the existing dynamic-lookup
walk and prepass bookkeeping, while repeated lexical scans exceed the budget.
All native accesses still report, so omitting analysis cannot satisfy it.
Script and CommonJS blocks with no function declarations must not create empty
Annex B tables that disable the same safe jump; real hoists are tested separately.
*/
it.each(['module', 'script', 'commonjs'] as const)(
  'does not revisit unrelated scopes before a resolved binding in %s',
  async (sourceType) => {
    let upperReads = 0;
    let blockCount = 0;
    const probe: Rule.RuleModule = {
      meta: { schema: [] },
      create(context) {
        for (const scope of context.sourceCode.scopeManager.scopes) {
          if (scope.type !== 'block') {
            continue;
          }
          blockCount += 1;
          const upper = scope.upper;
          Object.defineProperty(scope, 'upper', {
            get(): typeof upper {
              upperReads += 1;
              return upper;
            },
          });
        }
        return {};
      },
    };
    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: [
        {
          languageOptions: { sourceType },
          plugins: { probe: { rules: { uppers: probe } }, reboop: plugin },
          rules: { 'probe/uppers': 'error', 'reboop/require-client': 'error' },
        },
      ],
    });
    const depth = 48;
    const count = 32;
    const [result] = await eslint.lintText(
      `${'{'.repeat(depth)}${'globalThis.fetch;'.repeat(count)}${'}'.repeat(depth)}`,
      { filePath: 'src/client.js' },
    );
    expect(result?.fatalErrorCount).toBe(0);
    expect(result?.messages).toHaveLength(count);
    expect(result?.messages.every((message) => message.ruleId === 'reboop/require-client')).toBe(
      true,
    );
    expect(blockCount).toBe(depth);
    expect(upperReads).toBeLessThanOrEqual((count + 4) * depth * 2);
  },
);
