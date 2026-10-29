import { ESLint } from 'eslint';
import type { Rule } from 'eslint';
import { expect, it } from 'vitest';
import plugin from '../../packages/reboop-eslint/src/index.js';

/**
Each exported field needs only its own path through a known destructuring
pattern. Count reads of the original property keys, values, and ranges to keep
both small and generated patterns linear; scanning siblings by either values
or positional ranges must fail. The probe preserves every original value.
A native request field, a nested known-absent namespace default, and a direct
Fetch reference must still report at their original locations, so suppressing
declaration analysis, defaults, or the remaining visitors cannot meet the budget.
*/
it.each([3, 64])('bounds known exported-pattern work for %i fields', async (count) => {
  let reads = 0;
  const probe: Rule.RuleModule = {
    meta: { schema: [] },
    create(context) {
      const statement = context.sourceCode.ast.body.find(
        (node) => node.type === 'ExportNamedDeclaration',
      );
      const declaration =
        statement?.type === 'ExportNamedDeclaration' ? statement.declaration : undefined;
      const pattern =
        declaration?.type === 'VariableDeclaration' ? declaration.declarations[0]?.id : undefined;
      if (pattern?.type !== 'ObjectPattern') {
        throw new Error('Expected the known exported destructuring fixture');
      }
      for (const property of pattern.properties) {
        if (property.type !== 'Property') {
          throw new Error('Expected an ordinary exported field');
        }
        for (const [name, original] of [
          ['key', property.key],
          ['value', property.value],
          ['range', property.range],
        ] as const) {
          Object.defineProperty(property, name, {
            get(): typeof original {
              reads += 1;
              return original;
            },
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
        plugins: { probe: { rules: { fields: probe } } },
        rules: { 'probe/fields': 'error' },
      },
      plugin.configs.recommended,
    ],
  });
  const fields = Array.from(
    { length: count },
    (_, index) => `createServer:local${String(index)}`,
  ).join(',');
  const fallback =
    "export const{createServer:ordinary,'module.exports':{default:client}=http}=http;";
  const code = `import*as http from'node:http';export const{${fields}}=http;export const{request:raw}=http;${fallback}globalThis.fetch;`;
  const [result] = await eslint.lintText(code, { filePath: 'src/client.js' });
  expect(result?.fatalErrorCount).toBe(0);
  expect(result?.messages).toEqual([
    expect.objectContaining({
      ruleId: 'reboop/require-client',
      column: code.indexOf('request:raw') + 1,
    }),
    expect.objectContaining({
      ruleId: 'reboop/require-client',
      column: code.indexOf(fallback) + 1,
    }),
    expect.objectContaining({
      ruleId: 'reboop/require-client',
      column: code.indexOf('globalThis.fetch') + 1,
    }),
  ]);
  expect(reads).toBeLessThanOrEqual(count * 9);
});
