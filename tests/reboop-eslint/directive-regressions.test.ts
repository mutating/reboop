import { parser } from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

describe('strict directive interpretation regressions', () => {
  /**
  Compilers can disagree about promoting a string after an erased type or
  inside an erased expression wrapper into a directive. Preserve the parser's
  sloppy script mode in that uncertainty instead of inventing strict lookup
  and rejecting the script's Annex B function binding.
  */
  it.each([
    "type T=string;'use strict';{function fetch(){}}fetch('/items');",
    "'use strict' as string;{function fetch(){}}fetch('/items');",
  ])('preserves parser mode for uncertain directive promotion: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser, sourceType: 'script' } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  A parenthesized TypeScript wrapper can also become a directive during emit.
  Its uncertainty must propagate into the namespace, whose parser mode is
  strict, rather than incorrectly treating the parenthesized literal as a
  known non-directive and hoisting the namespace's block function.
  */
  it('retains parser strictness after a parenthesized erased wrapper', async () => {
    const result = await lint(
      "('use strict' as string);namespace N{{function fetch(){}}fetch('/items');}",
      'src/client.ts',
      [{ files: ['**/*.ts'], languageOptions: { parser, sourceType: 'script' } }],
    );
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Empty bodies and custom string-only prologues do not enable strict mode.
  Parameter defaults inherit that function mode, so an Annex B function in
  their nested arrow remains local. The namespace's parser mode is strict,
  so inventing a possible directive at the end of the function's statement
  list would incorrectly retain that mode and reject the local binding.
  */
  it.each([
    "namespace N{function use(value=()=>{{function fetch(){}}fetch('/items');}){}use();}",
    "namespace N{function use(value=()=>{{function fetch(){}}fetch('/items');}){'custom';}use();}",
  ])('keeps parameter defaults sloppy without a strict directive: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser, sourceType: 'script' } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  An expression-bodied arrow has no statement list even when the returned
  expression itself has a body. Treating that inner function's BlockStatement
  as the arrow's directive list would throw while linting valid JavaScript.
  */
  it('accepts an arrow returning a function expression', async () => {
    const result = await lint('const use=()=>function(){};');
    expect(result.messages).toEqual([]);
  });

  /**
  A shorthand ambient module is valid TypeScript and creates a module scope
  without a body. Directive inspection must accept that missing statement list
  instead of dereferencing a body while initializing the rule's scope model.
  */
  it('accepts a shorthand ambient module without a body', async () => {
    const result = await lint("declare module 'optional-client';", 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser, sourceType: 'script' } },
    ]);
    expect(result.messages).toEqual([]);
  });
});
