import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createClient, HTTPError, TimeoutError } from '../../packages/reboop/src/index.js';

const endpoint = 'https://api.example.test/items';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('custom response readers', () => {
  /**
  A synchronous reader receives the original successful Response and returns its
  own value without an envelope. The third argument remains normal request
  options; strict identity detects clones, and credentials/headers detect lost
  or reordered request options.
  */
  it('reads metadata synchronously and forwards request options', async () => {
    const response = new Response(undefined, { status: 204, headers: { ETag: 'version-1' } });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const reader = vi.fn((result: Response) => ({
      etag: result.headers.get('etag'),
      status: result.status,
    }));
    const client = createClient({ fetch: fetcher, baseUrl: 'https://api.example.test/' });
    const result = await client.read('items', reader, {
      method: 'HEAD',
      credentials: 'include',
      headers: { 'X-Reader': 'yes' },
      timeoutMs: 10,
      retries: 0,
    });
    expect(result).toEqual({ etag: 'version-1', status: 204 });
    expectTypeOf(result).toEqualTypeOf<{ etag: string | null; status: number }>();
    expect(reader).toHaveBeenCalledExactlyOnceWith(response);
    expect(reader.mock.calls.at(0)?.[0]).toBe(response);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const call = fetcher.mock.calls.at(0);
    if (call === undefined) {
      throw new Error('Expected a fetch call');
    }
    const request = new Request(call[0], call[1]);
    expect(request.url).toBe(endpoint);
    expect(request.method).toBe('HEAD');
    expect(request.credentials).toBe('include');
    expect(request.headers.get('x-reader')).toBe('yes');
  });

  /**
  Body and metadata must come from the same completed attempt. A partial first
  body fails after headers; rerunning the whole reader must discard its bytes
  and old ETag/Link/status. Exact Response identities also catch retry-only
  cloning, while the body failure catches reading outside retry protection.
  */
  it('returns body and metadata from the successful retry only', async () => {
    const body = new TransformStream<Uint8Array, Uint8Array>();
    const writer = body.writable.getWriter();
    const first = new Response(body.readable, { headers: { ETag: 'stale', Link: 'old page' } });
    const second = new Response('complete', {
      status: 201,
      headers: { ETag: 'fresh', Link: '</next>; rel="next"' },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(first).mockResolvedValue(second);
    const reader = vi.fn(async (response: Response) => ({
      body: await response.text(),
      etag: response.headers.get('etag'),
      next: response.headers.get('link'),
      status: response.status,
    }));
    const pending = createClient({ fetch: fetcher, retries: 0 }).read(endpoint, reader, {
      retries: 1,
    });
    const settled = Promise.allSettled([pending]);
    await writer.write(new TextEncoder().encode('discard this prefix'));
    await writer.abort(new TypeError('terminated'));
    await vi.advanceTimersByTimeAsync(1000);
    await expect(settled).resolves.toEqual([
      {
        status: 'fulfilled',
        value: { body: 'complete', etag: 'fresh', next: '</next>; rel="next"', status: 201 },
      },
    ]);
    expect(reader).toHaveBeenNthCalledWith(1, first);
    expect(reader).toHaveBeenNthCalledWith(2, second);
    expect(reader.mock.calls.at(0)?.[0]).toBe(first);
    expect(reader.mock.calls.at(1)?.[0]).toBe(second);
    expect(reader).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  /**
  The deadline covers the whole asynchronous reader, even when it ignores
  cancellation. A late first result cannot replace the recovered value; the
  request override and exact backoff boundary detect a header-only wrapper.
  */
  it('times out a pending reader and ignores its late result after recovery', async () => {
    const deferred = Promise.withResolvers<string>();
    const first = new Response();
    const second = new Response('fresh');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(first).mockResolvedValue(second);
    const reader = vi
      .fn<(response: Response) => string | Promise<string>>()
      .mockReturnValueOnce(deferred.promise)
      .mockImplementation((response) => response.text());
    const pending = createClient({ fetch: fetcher, timeoutMs: 100, retries: 1 }).read(
      endpoint,
      reader,
      { timeoutMs: 10 },
    );
    expectTypeOf(pending).toEqualTypeOf<Promise<string>>();
    await vi.advanceTimersByTimeAsync(9);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const signal = fetcher.mock.calls.at(0)?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBeInstanceOf(TimeoutError);
    expect(signal?.reason).toMatchObject({ timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe('fresh');
    deferred.resolve('stale');
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toBe('fresh');
    expect(reader).toHaveBeenCalledTimes(2);
  });

  /**
  Caller cancellation stops a pending reader without changing its exact reason.
  A later network-like rejection must remain handled and cannot start retries;
  this catches moving reader execution outside the cancellation scope.
  */
  it('cancels a pending reader and ignores its later rejection', async () => {
    const deferred = Promise.withResolvers<string>();
    const controller = new AbortController();
    const reason = new Error('view disposed');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response());
    const reader = vi.fn(() => deferred.promise);
    const settled = Promise.allSettled([
      createClient({ fetch: fetcher }).read(endpoint, reader, { signal: controller.signal }),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(reader).toHaveBeenCalledTimes(1);
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    const ready = await Promise.race([settled, Promise.resolve(undefined)]);
    expect(ready).toBeDefined();
    const [outcome] = ready ?? [];
    expect(outcome?.status).toBe('rejected');
    const error: unknown = outcome?.status === 'rejected' ? outcome.reason : outcome;
    expect(error).toBe(reason);
    deferred.reject(new TypeError('terminated'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledTimes(1);
  });

  /**
  A reader does not change retry safety: parse/validation failures stop a GET,
  and a POST body transport failure cannot replay the write. Exact errors and
  one invocation detect unconditional retries or wrapping callback failures.
  */
  it.each([
    { name: 'GET parse failure', method: 'GET', error: new SyntaxError('invalid record') },
    { name: 'GET validation failure', method: 'GET', error: new Error('schema rejected') },
    { name: 'POST transport failure', method: 'POST', error: new TypeError('terminated') },
  ])('preserves retry safety for $name', async ({ method, error }) => {
    const response = new Response('unread');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const reader = vi.fn<(_response: Response) => Promise<never>>().mockRejectedValue(error);
    const pending = createClient({ fetch: fetcher, retries: 0 }).read(endpoint, reader, {
      method,
      retries: 2,
    });
    const settled = Promise.allSettled([pending]);
    await vi.runAllTimersAsync();
    const [outcome] = await settled;
    expect(outcome.status).toBe('rejected');
    const failure: unknown = outcome.status === 'rejected' ? outcome.reason : outcome;
    expect(failure).toBe(error);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await response.body?.cancel();
  });

  /**
  Readers see only successful responses: HTTP failures retain the original
  unread Response and never invoke application parsing or validation code.
  This catches exposing fetch directly instead of the protected send path.
  */
  it('rejects HTTP errors before invoking the reader', async () => {
    const response = new Response('unavailable', { status: 503 });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const reader = vi.fn(() => 'unexpected success');
    const [outcome] = await Promise.allSettled([
      createClient({ fetch: fetcher }).read(endpoint, reader),
    ]);
    const error: unknown = outcome.status === 'rejected' ? outcome.reason : outcome;
    expect(error).toBeInstanceOf(HTTPError);
    expect((error as HTTPError).response).toBe(response);
    expect(response.bodyUsed).toBe(false);
    await expect(response.text()).resolves.toBe('unavailable');
    expect(reader).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
