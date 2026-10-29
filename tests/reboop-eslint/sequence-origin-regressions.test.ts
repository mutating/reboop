import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

describe('sequence expression origin regressions', () => {
  /**
  A sequence returns its final operand, even after unrelated primitive and
  object values. Selecting either earlier operand or dropping the final value
  would lose this global alias and let a native Fetch acquisition pass.
  */
  it('retains a native global object in the final operand', async () => {
    const result = await lint('const root=(0,{},globalThis);root.fetch;');
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Earlier native global objects do not determine a sequence's resulting value.
  The final local client must remain local; choosing the first or middle
  operand would fabricate a native Fetch origin and a false diagnostic.
  */
  it('keeps a local client in the final operand local', async () => {
    const result = await lint(
      'const local={fetch(){}};const root=(globalThis,globalThis,local);root.fetch;',
    );
    expect(result.messages).toEqual([]);
  });

  /**
  The final value can also be a CommonJS loader. Keeping its origin allows a
  subsequent native HTTP method acquisition to be detected without calling it.
  A first/middle-operand shortcut or lost result would hide this loading route.
  */
  it('retains a CommonJS loader in the final operand', async () => {
    const result = await lint(
      "const load=(0,()=>{},require);load('http').request;",
      'src/client.cjs',
    );
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });
});
