import { ESLint } from 'eslint';
import type { Rule } from 'eslint';
import { expect, it } from 'vitest';
import plugin from '../../packages/reboop-eslint/src/index.js';

/**
Observe the first helper's actual pattern/default values after traversal. The
probe preserves every value and counts only later analysis. A ParameterDefinition
must still resolve the positive control. An independent require acquisition
also catches blanket removal of CallExpression analysis.
*/
async function measuredLint(code: string, marker: string): Promise<number> {
  let reads = 0;
  const probe: Rule.RuleModule = {
    meta: { schema: [] },
    create(context) {
      const declaration = context.sourceCode.ast.body.find(
        (node) => node.type === 'FunctionDeclaration' && node.id.name === 'helper',
      );
      const parameter =
        declaration?.type === 'FunctionDeclaration' ? declaration.params[0] : undefined;
      if (parameter?.type === 'ObjectPattern') {
        for (const property of parameter.properties) {
          if (property.type !== 'Property') {
            throw new Error('Expected a helper property');
          }
          const value = property.value;
          Object.defineProperty(property, 'value', {
            get(): typeof value {
              reads += 1;
              return value;
            },
          });
        }
      } else if (parameter?.type === 'AssignmentPattern') {
        const right = parameter.right;
        Object.defineProperty(parameter, 'right', {
          get(): typeof right {
            reads += 1;
            return right;
          },
        });
      } else {
        throw new Error('Expected a helper pattern or default');
      }
      return {};
    },
  };
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        languageOptions: { sourceType: 'commonjs' },
        plugins: { probe: { rules: { values: probe } } },
        rules: { 'probe/values': 'error' },
      },
      plugin.configs.recommended,
    ],
  });
  const [result] = await eslint.lintText(`${code}require('axios');`, {
    filePath: 'src/client.cjs',
  });
  expect(result?.fatalErrorCount).toBe(0);
  expect(result?.messages).toEqual([
    expect.objectContaining({ ruleId: 'reboop/require-client', column: code.indexOf(marker) + 1 }),
    expect.objectContaining({ ruleId: 'reboop/require-client', column: code.length + 1 }),
  ]);
  return reads;
}

/**
A function's own name is outside all parameter patterns. Resolving that name
cannot select any origin from the first destructured parameter, so short and
wide patterns should incur only their own visitor work, never a scan per call.
Restoring FunctionName parameter analysis exceeds the budget. The namespace
callback's ns.request control catches accidentally disabling Parameter origins.
*/
it.each([3, 64])('does not scan %i parameter fields for a function-name origin', async (count) => {
  const fields = Array.from({ length: count }, (_, index) => `value${String(index)}`).join(',');
  const code = `function helper({${fields}}){}${'helper({});'.repeat(32)}import('node:http').then(ns=>ns.request('/api'));`;
  const reads = await measuredLint(code, 'ns.request');
  expect(reads).toBeLessThanOrEqual(count * 2);
});

/**
Resolving a local function name must not evaluate its first parameter default:
that work can follow an unused alias chain and overflow the resolver stack.
Count the default read rather than depending on an engine stack-size limit.
The independent native client parameter default remains active, protecting
ParameterDefinition fallback resolution while FunctionName is skipped.
*/
it('does not inspect a parameter default to resolve the function name', async () => {
  const code = `function helper(client=defaultClient){}const defaultClient={};${'helper();'.repeat(32)}function native(client=require('node:http')){client.request('/api')}`;
  const reads = await measuredLint(code, 'client.request');
  expect(reads).toBe(0);
});
