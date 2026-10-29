import { ESLint } from 'eslint';
import type { Rule, SourceCode } from 'eslint';
import { parser } from 'typescript-eslint';
import { expect, it } from 'vitest';
import plugin from '../../packages/reboop-eslint/src/index.js';

/**
Observe parent metadata without changing links. A preceding rule installs the
probe after ESLint has completed traversal and before the plugin creates its
resolver, so framework construction does not contribute to the work budget.
*/
async function measuredLint(
  code: string,
  select: (source: SourceCode) => readonly Rule.Node[],
): Promise<{ reads: number; result: ESLint.LintResult }> {
  let reads = 0;
  const probe: Rule.RuleModule = {
    meta: { schema: [] },
    create(context) {
      for (const node of select(context.sourceCode)) {
        let parent = node.parent;
        const descriptor = Object.getOwnPropertyDescriptor(node, 'parent');
        Object.defineProperty(node, 'parent', {
          get(): typeof parent {
            reads += 1;
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
        files: ['**/*.ts'],
        languageOptions: { parser },
        plugins: { probe: { rules: { parents: probe } } },
        rules: { 'probe/parents': 'error' },
      },
      plugin.configs.recommended,
    ],
  });
  const [result] = await eslint.lintText(code, { filePath: 'src/client.ts' });
  if (result === undefined) {
    throw new Error('Expected an ESLint result');
  }
  expect(result.fatalErrorCount).toBe(0);
  expect(result.warningCount).toBe(0);
  expect(result.messages).toEqual([
    expect.objectContaining({
      ruleId: 'reboop/require-client',
      column: code.lastIndexOf("fetch('/api')") + 1,
    }),
  ]);
  return { reads, result };
}

/**
Unrelated declaration names cannot directly name native Fetch or XMLHttpRequest.
Do not walk their ancestry before checking the spelling. Expression visitors
resolve aliases separately. Counting real parser
parent reads catches moving the expensive erasure predicate ahead of the name
gate. The erased typeof Fetch reference and the final runtime call also ensure
that retaining the fast gate does not bypass erasure or native reporting.
*/
it('checks identifier spelling before walking irrelevant declaration ancestry', async () => {
  const declarations = Array.from(
    { length: 64 },
    (_, index) => `const local${String(index)}=${String(index)};`,
  ).join('');
  const code = `${declarations}type Native=typeof fetch;fetch('/api');`;
  const { reads } = await measuredLint(code, (source) =>
    source.scopeManager.scopes.flatMap((scope) =>
      scope.variables.flatMap((variable) =>
        variable.identifiers
          .filter((identifier) => identifier.name.startsWith('local'))
          .map((identifier) => identifier as unknown as Rule.Node),
      ),
    ),
  );
  expect(reads).toBe(0);
});

/**
Object-literal properties never select a destructured transport. Their parent
kind is enough to reject them without walking erased ancestry. One parent read
per property is sufficient; reversing the cheap gate exceeds that budget. The
ambient initializer is deliberately parseable but semantically incomplete TS,
representing an editor state: its erased binding must keep the existing absence
of diagnostics even while unrelated runtime Fetch is still diagnosed.
*/
it('rejects object-literal properties before walking their ancestry', async () => {
  const count = 64;
  const entries = Array.from({ length: count }, (_, index) => `{value:${String(index)}}`).join(',');
  const incomplete = 'declare namespace Ambient{const{fetch}=globalThis;}';
  const code = `const rows=[${entries}];${incomplete}fetch('/api');`;
  const { reads } = await measuredLint(code, (source) => {
    const declaration = source.ast.body[0];
    if (declaration?.type !== 'VariableDeclaration') {
      throw new Error('Expected the row declaration');
    }
    const array = declaration.declarations[0]?.init;
    if (array?.type !== 'ArrayExpression') {
      throw new Error('Expected the object row fixture');
    }
    return array.elements.flatMap((element) => {
      if (element?.type !== 'ObjectExpression') {
        throw new Error('Expected an object row');
      }
      return element.properties.map((property) => property as unknown as Rule.Node);
    });
  });
  expect(reads).toBeLessThanOrEqual(count);
});
