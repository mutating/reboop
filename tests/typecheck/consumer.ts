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
