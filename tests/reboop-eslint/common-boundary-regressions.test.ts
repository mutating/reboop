import { expect, it } from 'vitest';
import {
  builtinLoader,
  common,
  loader,
  loaderFactory,
} from '../../packages/reboop-eslint/src/transports.js';

/**
Unknown provenance cannot agree with any loader capability. The ordinary and
builtin-only rows reject accidentally treating a missing left side as the
other loader kind; the factory row checks the missing-origin guard before
graph traversal. Check both orders so caller short circuits cannot hide a
broken boundary inside the intersection helper itself.
*/
it.each([
  { name: 'ordinary loader', origin: loader },
  { name: 'builtin-only loader', origin: builtinLoader },
  { name: 'loader factory', origin: loaderFactory },
])('keeps an unknown origin distinct from a $name', ({ origin }) => {
  expect(common(undefined, origin)).toBeUndefined();
  expect(common(origin, undefined)).toBeUndefined();
});
