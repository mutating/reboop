import pRetry from 'p-retry';
import { expect, it, vi } from 'vitest';
import { createClient } from '../../packages/reboop/src/index.js';

vi.mock('p-retry', () => ({ default: vi.fn() }));

it('preserves unexpected retry-engine failures without masking them as attempt errors', async () => {
  const error = new Error('Retry engine unavailable');
  vi.mocked(pRetry).mockRejectedValue(error);
  const fetcher = vi.fn<typeof fetch>();
  await expect(createClient({ fetch: fetcher }).request('https://example.test/')).rejects.toBe(
    error,
  );
  expect(fetcher).not.toHaveBeenCalled();
});
