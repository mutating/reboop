import { ESLint } from 'eslint';
import type { Rule } from 'eslint';
import { expect, it } from 'vitest';
import plugin from '../../packages/reboop-eslint/src/index.js';

/**
Ordinary local destructuring has no known namespace to export. Rejecting that
origin before inspecting its target avoids both resolving a local binding and
unwrapping its defaults. Count real property-value reads: no target inspection
is needed for either a short hook-style pattern or a wider generated pattern.
The probe returns the original values. Native Fetch acquisition and a known-absent
CommonJS namespace default must still report, so skipping the Property visitor
or dropping fallback analysis cannot satisfy this work budget.
*/
it.each([3, 64])('bounds target analysis for %i ordinary destructured fields', async (count) => {
  let reads = 0;
  const probe: Rule.RuleModule = {
    meta: { schema: [] },
    create(context) {
      const declaration = context.sourceCode.ast.body.find(
        (node) => node.type === 'VariableDeclaration',
      );
      const pattern = declaration?.declarations[0]?.id;
      if (pattern?.type !== 'ObjectPattern') {
        throw new Error('Expected the local destructuring fixture');
      }
      for (const property of pattern.properties) {
        if (property.type !== 'Property') {
          throw new Error('Expected an ordinary property');
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
        languageOptions: { sourceType: 'commonjs' },
        plugins: { probe: { rules: { values: probe } } },
        rules: { 'probe/values': 'error' },
      },
      plugin.configs.recommended,
    ],
  });
  const names = Array.from({ length: count }, (_, index) => `local${String(index)}`).join(',');
  const code = `function useQuery(){return{}}const{${names}}=useQuery();const{fetch:request}=globalThis;({default:module.exports=require('node:http')}=require('node:https'));`;
  const [result] = await eslint.lintText(code, { filePath: 'src/client.cjs' });
  expect(result?.fatalErrorCount).toBe(0);
  expect(result?.messages).toEqual([
    expect.objectContaining({
      ruleId: 'reboop/require-client',
      column: code.indexOf('fetch:request') + 1,
    }),
    expect.objectContaining({
      ruleId: 'reboop/require-client',
      column: code.indexOf('default:module') + 1,
    }),
  ]);
  expect(reads).toBe(0);
});

/**
A reassigned local target is rejected before its known-absent default is
resolved. Preserve that short circuit: eagerly selecting the fallback can
walk an otherwise unused alias chain and overflow the resolver stack. Count
reads of the actual default expression instead of fixing a stack-depth limit.
An independent CommonJS export still activates its known-absent namespace
default, so suppressing all default analysis cannot pass.
*/
it('does not evaluate a fallback hidden behind a reassigned local target', async () => {
  let reads = 0;
  const probe: Rule.RuleModule = {
    meta: { schema: [] },
    create(context) {
      const statement = context.sourceCode.ast.body[0];
      const pattern =
        statement?.type === 'VariableDeclaration' ? statement.declarations[0]?.id : undefined;
      const property = pattern?.type === 'ObjectPattern' ? pattern.properties[0] : undefined;
      const assignment = property?.type === 'Property' ? property.value : undefined;
      if (assignment?.type !== 'AssignmentPattern') {
        throw new Error('Expected the local fallback fixture');
      }
      const right = assignment.right;
      Object.defineProperty(assignment, 'right', {
        get(): typeof right {
          reads += 1;
          return right;
        },
      });
      return {};
    },
  };
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        languageOptions: { sourceType: 'commonjs' },
        plugins: { probe: { rules: { fallback: probe } } },
        rules: { 'probe/fallback': 'error' },
      },
      plugin.configs.recommended,
    ],
  });
  const code =
    "let{default:client=globalThis}=require('node:http');client=0;({default:module.exports=require('node:http')}=require('node:https'));";
  const [result] = await eslint.lintText(code, { filePath: 'src/client.cjs' });
  expect(result?.fatalErrorCount).toBe(0);
  expect(result?.messages).toEqual([
    expect.objectContaining({
      ruleId: 'reboop/require-client',
      column: code.indexOf('default:module') + 1,
    }),
  ]);
  expect(reads).toBe(0);
});
