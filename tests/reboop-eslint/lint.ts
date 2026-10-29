import { ESLint } from 'eslint';
import type { Linter } from 'eslint';
import { expect } from 'vitest';
import plugin from '../../packages/reboop-eslint/src/index.js';

export async function lint(
  code: string,
  filePath = 'src/client.js',
  config: Linter.Config[] = [],
): Promise<ESLint.LintResult> {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [plugin.configs.recommended, ...config],
  });
  const [result] = await eslint.lintText(code, { filePath });
  if (result === undefined) {
    throw new Error('Expected ESLint to process the source');
  }
  expect(result.fatalErrorCount).toBe(0);
  expect(result.warningCount).toBe(0);
  return result;
}
