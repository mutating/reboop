import { parser } from 'typescript-eslint';
import { expect, it } from 'vitest';
import { lint } from './lint.js';

/**
An unresolved TypeScript export has both type and value reference flags, but no
resolved binding. The rule must tolerate partially written modules rather than
dereferencing that missing binding or inventing a transport. The type checker
owns the missing-name error; this test protects the rule's error handling.
Removing the optional resolved-binding lookup makes this lint operation throw.
*/
it('tolerates an unresolved type-and-value export', async () => {
  const result = await lint('export {FutureClient};', 'src/client.ts', [
    { files: ['**/*.ts'], languageOptions: { parser } },
  ]);
  expect(result.messages).toEqual([]);
});
