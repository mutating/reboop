import { ESLint } from 'eslint';
import type { Rule } from 'eslint';
import { parser } from 'typescript-eslint';
import { expect, it } from 'vitest';
import plugin from '../../packages/reboop-eslint/src/index.js';
import { lint } from './lint.js';

/**
Many references can share deep lexical ancestry. Count actual parent-link reads
instead of wall time: each shared block needs analysis once, not per visitor.
The probe returns the original links, and all native accesses must still report
so bypassing analysis cannot satisfy the work budget. An iterative traversal
also avoids growing the JS call stack for deeply nested source.
*/
it('shares type-only ancestry work across runtime visitors', async () => {
  let parentReads = 0;
  let blockCount = 0;
  const probe: Rule.RuleModule = {
    meta: { schema: [] },
    create(context) {
      for (const scope of context.sourceCode.scopeManager.scopes) {
        if (scope.block.type !== 'BlockStatement') {
          continue;
        }
        blockCount += 1;
        const block = scope.block as unknown as Rule.Node;
        let parent = block.parent;
        const descriptor = Object.getOwnPropertyDescriptor(block, 'parent');
        Object.defineProperty(block, 'parent', {
          get(): typeof parent {
            parentReads += 1;
            return parent;
          },
          set(value: typeof parent): void {
            parent = value;
          },
          configurable: true,
          enumerable: descriptor?.enumerable ?? false,
        });
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
  const depth = 64;
  const count = 48;
  const [result] = await eslint.lintText(
    `${'{'.repeat(depth)}${'globalThis.fetch;'.repeat(count)}${'}'.repeat(depth)}`,
    { filePath: 'src/client.js' },
  );
  if (result === undefined) {
    throw new Error('Expected ESLint to process the source');
  }
  expect(result.fatalErrorCount).toBe(0);
  expect(result.messages).toHaveLength(count);
  expect(result.messages.every((message) => message.ruleId === 'reboop/require-client')).toBe(true);
  expect(blockCount).toBe(depth);
  expect(parentReads).toBeLessThanOrEqual(blockCount * 2);
});

/**
Runtime and erased subtrees can be adjacent and share ancestors. Memoized true
and false outcomes must remain attached to the actual AST nodes, including
type-only import specifiers, abstract member types, and merged namespaces. This catches leaking
an erased result into runtime siblings or treating a cached false as a miss.
*/
it('keeps erased and runtime siblings independent', async () => {
  const code = `
const visible=globalThis.fetch;
namespace Shared { export interface Row { value: typeof globalThis.fetch } }
namespace Shared { export const visible=globalThis.fetch; }
abstract class Shape {
  abstract value: typeof globalThis.fetch;
  visible = globalThis.fetch;
}
import type { fetch as Fetch } from 'undici';
`;
  const result = await lint(code, 'src/client.ts', [
    { files: ['**/*.ts'], languageOptions: { parser } },
  ]);
  expect(result.messages.map((message) => [message.ruleId, message.line, message.column])).toEqual([
    ['reboop/require-client', 2, 15],
    ['reboop/require-client', 4, 41],
    ['reboop/require-client', 7, 13],
  ]);
});
