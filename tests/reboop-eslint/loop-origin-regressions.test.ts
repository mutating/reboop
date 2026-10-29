import { parser } from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

describe('loop iteration origin regressions', () => {
  /**
  A for-of var declaration writes every iterated value into an existing var.
  Its bare declaration must not erase that iteration write when redundant var
  declarations are normalized. Otherwise the earlier globalThis initializer
  fabricates a native acquisition after the loop has replaced root with a
  custom client. TypeScript's erased RHS wrappers preserve the same write;
  each case rejects a mutant that forgets for-of initializer writes.
  */
  it.each(
    (
      [
        ['[custom]', 'js'],
        ['([custom] as any)', 'ts'],
        ['([custom] satisfies any[])', 'ts'],
        ['([custom]!)', 'ts'],
        ['(<any>[custom])', 'ts'],
        ['([custom] as any)!', 'ts'],
      ] as const
    ).map(([right, extension], caseIndex) => ({
      code: `var root${extension === 'ts' ? ':any' : ''}=globalThis;for(var root of ${right}){}consume(root.fetch);`,
      extension,
      caseIndex,
    })),
  )('retains the for-of write in case $caseIndex ($extension)', async ({ code, extension }) => {
    const result = await lint(code, `src/client.${extension}`, [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  A loop does not invalidate unrelated native aliases, and acquisitions within
  its body remain protected. Replacing one loop variable must not suppress a
  later independent alias either. These opposite controls reject a blanket
  exemption for loop-containing scopes, loop bodies or all var aliases while
  retaining the precise reassignment check exercised above.
  */
  it.each(
    [
      'var root=globalThis;for(var item of [custom]){}consume(root.fetch);',
      'var root=globalThis;for(var item of [custom]){consume(root.fetch);}',
      'for(var item of [custom]){const root=globalThis;consume(root.fetch);}',
      'var root=globalThis;for(var root of [custom]){}const native=globalThis;consume(native.fetch);',
    ].flatMap((code, caseIndex) =>
      ['js', 'ts'].map((extension) => ({
        code: extension === 'ts' ? code.replace('var root=', 'var root:any=') : code,
        extension,
        caseIndex,
      })),
    ),
  )(
    'retains an actual acquisition in case $caseIndex ($extension)',
    async ({ code, extension }) => {
      const result = await lint(code, `src/client.${extension}`, [
        { files: ['**/*.ts'], languageOptions: { parser } },
      ]);
      expect(result.messages).toEqual([
        expect.objectContaining({ ruleId: 'reboop/require-client' }),
      ]);
    },
  );
});
