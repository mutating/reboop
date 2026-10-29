import { parser } from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

describe('binding-pattern reference metadata', () => {
  /**
  Both supported parsers attach separate default-value and iteration writes to
  the same binding identifier. The reference index may select one canonical
  entry, but reassignment analysis must retain every write. Keeping only the
  first entry invents a native origin after this loop installs a local client.
  Executing the emitted code returns the local value without reading native
  Fetch; the first-reference-only mutant produces a false diagnostic.
  */
  it.each(['js', 'ts'] as const)(
    'retains all binding writes with %s metadata',
    async (extension) => {
      const type = extension === 'ts' ? ':any' : '';
      const rows = extension === 'ts' ? '([{}] as any[])' : '[{}]';
      const code = `const local={fetch(){return'local'}};var root${type}=globalThis;for(var{root=local}of${rows}){}root.fetch();`;
      const result = await lint(code, `src/client.${extension}`, [
        { files: ['**/*.ts'], languageOptions: { parser } },
      ]);
      expect(result.messages).toEqual([]);
    },
  );
});
