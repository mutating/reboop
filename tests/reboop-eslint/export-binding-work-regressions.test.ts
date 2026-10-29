import { ESLint } from 'eslint';
import type { Rule } from 'eslint';
import { expect, it } from 'vitest';
import plugin from '../../packages/reboop-eslint/src/index.js';

/**
Each exported binding asks for its own origin. Once the pattern's value is
unknown, no field can supply an origin: defaults activate only for known
absence. Count actual property-value reads: neither short configuration exports
nor wide generated exports need to inspect any field of an unknown value.
The probe preserves every value. A nested known-absent namespace default still
exports its module, an unmodeled field stays unknown, and computed/direct
Fetch acquisitions still report, so
skipping export analysis, defaults, or child visitors cannot satisfy the budget.
*/
it.each([3, 64])('bounds unknown exported-pattern work for %i fields', async (count) => {
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
        throw new Error('Expected the exported configuration pattern');
      }
      for (const property of pattern.properties) {
        if (property.type !== 'Property') {
          throw new Error('Expected an ordinary configuration field');
        }
        const value = property.value;
        Object.defineProperty(property, 'value', {
          get(): typeof value {
            reads += 1;
            return value;
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
        plugins: { probe: { rules: { values: probe } } },
        rules: { 'probe/values': 'error' },
      },
      plugin.configs.recommended,
    ],
  });
  const fields = Array.from({ length: count }, (_, index) => `local${String(index)}`).join(',');
  const namespaceExport = "export const {'module.exports': {default: client}=http}=http;";
  const code = `import * as http from 'node:http';function loadConfig(){return{}}export const {${fields}}=loadConfig();export const {createServer:untouched=http}=http;${namespaceExport}export const {[globalThis.fetch.name]:computed}=loadConfig();export const {fetch:request}=globalThis;`;
  const [result] = await eslint.lintText(code, { filePath: 'src/client.js' });
  expect(result?.fatalErrorCount).toBe(0);
  expect(result?.messages).toEqual([
    expect.objectContaining({
      ruleId: 'reboop/require-client',
      column: code.indexOf(namespaceExport) + 1,
    }),
    expect.objectContaining({
      ruleId: 'reboop/require-client',
      column: code.indexOf('globalThis.fetch.name') + 1,
    }),
    expect.objectContaining({
      ruleId: 'reboop/require-client',
      column: code.indexOf('fetch:request') + 1,
    }),
  ]);
  expect(reads).toBe(0);
});
