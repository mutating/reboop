import { ESLint } from 'eslint';
import type { Rule } from 'eslint';
import { expect, it } from 'vitest';
import plugin from '../../packages/reboop-eslint/src/index.js';

/**
A function with no parameters cannot contain a reference in a parameter default.
Repeatedly walking each body identifier's ancestry is therefore unnecessary.
The probe preserves parent links while counting reads, avoiding timing-based CI
thresholds. Removing the empty-parameter fast path exceeds the linear budget;
all native accesses must still be reported so skipping analysis cannot pass.
The script includes an Annex B block function, retaining the conservative scope
lookup path even when ordinary module lookups can jump to their resolved scope.
*/
it('avoids parameter ancestry walks for an empty parameter list', async () => {
  let parentReads = 0;
  let referenceCount = 0;
  const probe: Rule.RuleModule = {
    meta: { schema: [] },
    create(context) {
      for (const scope of context.sourceCode.scopeManager.scopes) {
        if (
          scope.type !== 'function' ||
          scope.block.type !== 'FunctionDeclaration' ||
          scope.block.params.length > 0
        ) {
          continue;
        }
        for (const reference of scope.references) {
          if (reference.identifier.name !== 'root') {
            continue;
          }
          referenceCount += 1;
          const identifier = reference.identifier as unknown as Rule.Node;
          let parent = identifier.parent;
          const descriptor = Object.getOwnPropertyDescriptor(identifier, 'parent');
          Object.defineProperty(identifier, 'parent', {
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
      }
      return {};
    },
  };
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        languageOptions: { sourceType: 'script' },
        plugins: { probe: { rules: { count: probe } }, reboop: plugin },
        rules: { 'probe/count': 'error', 'reboop/require-client': 'error' },
      },
    ],
  });
  const count = 48;
  const [result] = await eslint.lintText(
    `const root=globalThis;if(true){function marker(){}}function use(){${'root.fetch;'.repeat(count)}}`,
    { filePath: 'src/client.js' },
  );
  if (result === undefined) {
    throw new Error('Expected ESLint to process the source');
  }
  expect(result.fatalErrorCount).toBe(0);
  expect(result.messages).toHaveLength(count);
  expect(result.messages.every((message) => message.ruleId === 'reboop/require-client')).toBe(true);
  expect(referenceCount).toBe(count);
  expect(parentReads).toBeLessThanOrEqual(referenceCount * 3);
});
