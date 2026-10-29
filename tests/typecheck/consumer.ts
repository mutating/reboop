import { createClient } from 'reboop';
import type { Client, ClientOptions, RequestOptions } from 'reboop';

// Check the published declarations under both Node-only and browser-only type environments.
const options = {
  baseUrl: new URL('https://api.example.test/v1/'),
  headers: new Headers({ Accept: 'application/json' }),
  credentials: 'include',
  fetch,
} satisfies ClientOptions;

const request = {
  signal: new AbortController().signal,
  retries: 2,
  timeoutMs: 1000,
  headers: [['X-Request', 'yes']],
  cache: 'no-store',
} satisfies RequestOptions;

export function readItems(): Promise<{ id: string }[]> {
  const client: Client = createClient(options);
  return client.json<{ id: string }[]>('items', request);
}

export function readPage(): Promise<{ body: string; next: string | null; status: number }> {
  return createClient(options).read(
    'items',
    async (response) => ({
      body: await response.text(),
      next: response.headers.get('Link'),
      status: response.status,
    }),
    request,
  );
}

export function readETag(): Promise<string | null> {
  return createClient(options).read('items', (response) => response.headers.get('ETag'), {
    method: 'HEAD',
  });
}
