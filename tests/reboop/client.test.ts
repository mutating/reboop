import { runInNewContext } from 'node:vm';
import { AbortError as RetryAbortError } from 'p-retry';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { createClient, HTTPError, TimeoutError } from '../../packages/reboop/src/index.js';
import type { Client, ClientOptions, RequestOptions } from '../../packages/reboop/src/index.js';

const endpoint = 'https://api.example.test/v1/items';

const readers = [
  { name: 'json', read: (client: Client): Promise<unknown> => client.json(endpoint) },
  { name: 'text', read: (client: Client): Promise<unknown> => client.text(endpoint) },
  { name: 'blob', read: (client: Client): Promise<unknown> => client.blob(endpoint) },
  { name: 'arrayBuffer', read: (client: Client): Promise<unknown> => client.arrayBuffer(endpoint) },
];

function hangingFetch(): Promise<Response> {
  return new Promise<Response>(() => {
    // Simulate a transport that never settles, even after cancellation.
  });
}

function getRequest(fetcher: Mock<typeof fetch>, index = 0): Request {
  const input = fetcher.mock.calls.at(index)?.[0];
  if (!(input instanceof Request)) {
    throw new TypeError('Expected a Request passed to fetch');
  }
  return new Request(input, fetcher.mock.calls.at(index)?.[1]);
}

function pendingResponse(): {
  response: Response;
  stream: ReadableStreamDefaultController<Uint8Array>;
} {
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller): void {
        stream = controller;
      },
    }),
  );
  if (stream === undefined) {
    throw new Error('Stream did not start');
  }
  return { response, stream };
}

/**
Compare binary bytes explicitly: bare ArrayBuffer equality failed to detect an
empty recovered buffer in the mutation challenge.
*/
async function expectRecoveredBody(name: string, result: unknown): Promise<void> {
  switch (name) {
    case 'json': {
      expect(result).toEqual({ ok: 1 });
      return;
    }
    case 'text': {
      expect(result).toBe('{"ok":1}');
      return;
    }
    case 'blob': {
      expect(result).toBeInstanceOf(Blob);
      await expect((result as Blob).text()).resolves.toBe('{"ok":1}');
      return;
    }
    case 'arrayBuffer': {
      expect(result).toBeInstanceOf(ArrayBuffer);
      expect(new Uint8Array(result as ArrayBuffer)).toEqual(new TextEncoder().encode('{"ok":1}'));
      return;
    }
    default: {
      throw new Error(`Missing assertion for reader ${name}`);
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('requests and response readers', () => {
  /**
  An explicitly empty header is an override, not an absent value.
  Keep its presence and empty contents while retaining unrelated defaults;
  this catches truthiness filters that accidentally reuse default credentials.
  */
  it('retains explicitly empty request header overrides', async () => {
    const headers = new Headers({ Authorization: 'Bearer default', 'X-Keep': 'yes' });
    const overrides = new Headers({ authorization: '' });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response());
    await createClient({ fetch: fetcher, headers }).request(endpoint, { headers: overrides });
    const request = getRequest(fetcher);
    expect(request.headers.has('authorization')).toBe(true);
    expect(request.headers.get('authorization')).toBe('');
    expect(request.headers.get('x-keep')).toBe('yes');
    expect(headers.get('authorization')).toBe('Bearer default');
    expect(overrides.get('authorization')).toBe('');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('replaces header groups without dropping repeated values', async () => {
    const defaults = new Headers([
      ['Set-Cookie', 'old=1'],
      ['Set-Cookie', 'old=2'],
      ['X-Keep', 'yes'],
      ['X-Replace', 'old'],
    ]);
    const headers = new Headers([
      ['Set-Cookie', 'a=1'],
      ['Set-Cookie', 'b=2'],
      ['X-Replace', 'new'],
    ]);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
    await createClient({ fetch: fetcher, headers: defaults }).request(endpoint, { headers });
    const result = getRequest(fetcher).headers;
    expect(result.getSetCookie()).toEqual(['a=1', 'b=2']);
    expect(result.get('x-keep')).toBe('yes');
    expect(result.get('x-replace')).toBe('new');
    expect(defaults.getSetCookie()).toEqual(['old=1', 'old=2']);
    expect(headers.getSetCookie()).toEqual(['a=1', 'b=2']);
  });

  it('accepts RequestInit class getters, including private state, without invoking unrelated getters', async () => {
    class WriteOptions implements RequestOptions {
      readonly #payload = 'payload';
      readonly #method = 'POST';
      get method(): string {
        return this.#method;
      }
      get body(): string {
        return this.#payload;
      }
      get headers(): Headers {
        return new Headers({ 'X-Test': this.#payload });
      }
      get unrelated(): never {
        throw new Error('Not a RequestInit field');
      }
    }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
    await expect(createClient({ fetch: fetcher }).text(endpoint, new WriteOptions())).resolves.toBe(
      'ok',
    );
    const request = getRequest(fetcher);
    expect(request.method).toBe('POST');
    expect(request.headers.get('x-test')).toBe('payload');
    await expect(request.text()).resolves.toBe('payload');
  });

  it('reads non-enumerable RequestInit fields', async () => {
    const options = Object.defineProperties(
      {},
      {
        method: { value: 'POST' },
        body: { value: 'hidden payload' },
        headers: { value: { 'X-Test': 'hidden' } },
      },
    );
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
    await createClient({ fetch: fetcher }).text(endpoint, options);
    const request = getRequest(fetcher);
    expect(request.method).toBe('POST');
    expect(request.headers.get('x-test')).toBe('hidden');
    await expect(request.text()).resolves.toBe('hidden payload');
  });

  it('snapshots RequestInit getters so retries cannot change the method or body', async () => {
    const method = vi.fn().mockReturnValueOnce('GET').mockReturnValue('POST');
    const body = vi.fn().mockReturnValueOnce(undefined).mockReturnValue('unsafe');
    const options: RequestOptions = Object.defineProperties(
      {},
      {
        method: { get: method },
        body: { get: body },
      },
    );
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(new Response('ok'));
    const pending = createClient({ fetch: fetcher, retries: 1 }).text(endpoint, options);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBe('ok');
    expect(method).toHaveBeenCalledTimes(1);
    expect(body).toHaveBeenCalledTimes(1);
    expect(getRequest(fetcher).method).toBe('GET');
    expect(getRequest(fetcher, 1).method).toBe('GET');
    await expect(getRequest(fetcher, 1).text()).resolves.toBe('');
  });

  it.each(['omit', 'include'] as const)(
    'preserves default credentials %s when the override is undefined',
    async (credentials) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
      const client = createClient({ fetch: fetcher, credentials });
      const pending: unknown = Reflect.apply(client.request, client, [
        endpoint,
        { credentials: undefined },
      ]);
      await expect(pending).resolves.toBeInstanceOf(Response);
      expect(getRequest(fetcher).credentials).toBe(credentials);
    },
  );

  it('uses global fetch with the native defaults and returns the original response', async () => {
    const response = new Response('hello');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetcher);
    const client = createClient();
    await expect(client.request(endpoint)).resolves.toBe(response);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const request = getRequest(fetcher);
    expect(request.url).toBe(endpoint);
    expect(request.method).toBe('GET');
    expect(request.credentials).toBe('same-origin');
    expect([...request.headers]).toEqual([]);
    expect(request.signal.aborted).toBe(false);
  });

  it('reads JSON without imposing headers or credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ answer: 42 }));
    const client = createClient({ fetch: fetcher });
    const data = await client.json<{ answer: number }>(new URL(endpoint));
    expect(data).toEqual({ answer: 42 });
    expectTypeOf(data).toEqualTypeOf<{ answer: number }>();
    expectTypeOf<ReturnType<typeof client.json>>().toEqualTypeOf<Promise<unknown>>();
    expect(getRequest(fetcher).headers.has('content-type')).toBe(false);
  });

  /**
  Response.json accepts falsy JSON values without replacing them with defaults.
  Exact primitive identity catches truthiness fallbacks that passed object-only
  examples; each response must still be read once without retrying.
  */
  it.each([null, false, 0, ''] as const)(
    'preserves the valid falsy JSON value %j',
    async (value) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(value));
      await expect(createClient({ fetch: fetcher }).json(endpoint)).resolves.toBe(value);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  /**
  A legal JSON key named __proto__ is an ordinary own data property.
  Native descriptors and prototype checks expose unsafe Object.assign copies,
  stripped keys and prototype substitution without imposing JSON object identity.
  */
  it('preserves special JSON keys as data without changing the parsed prototype', async () => {
    const payload = '{"__proto__":{"admin":true},"id":"record"}';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(payload));
    const result = await createClient({ fetch: fetcher }).json<Record<string, unknown>>(endpoint);
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')).toEqual({
      value: { admin: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result).toEqual(JSON.parse(payload));
    expect('admin' in result).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  /**
  Collection endpoints return top-level arrays, including empty results.
  Exact shape protects against object-only normalization or taking only the
  first item; the empty row catches generic empty-container-to-null fallbacks.
  */
  it.each([
    { name: 'empty', value: [] },
    { name: 'populated', value: [1, { id: 'item', enabled: false }, null] },
  ])('reads a $name top-level JSON array without changing its shape', async ({ value }) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(value));
    await expect(createClient({ fetch: fetcher }).json(endpoint)).resolves.toEqual(value);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  /**
  Text is data: surrounding whitespace and CRLF/LF sequences must survive.
  Exact native text output detects convenience trimming or newline normalization
  that would corrupt formatted files or data used for signature verification.
  */
  it('preserves text whitespace and original line endings', async () => {
    const value = ' \tline one\r\nline two\n ';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(value));
    await expect(createClient({ fetch: fetcher }).text(endpoint)).resolves.toBe(value);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reads text, Blob and ArrayBuffer', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        new Response('héllo', {
          headers: { 'content-type': 'text/plain' },
        }),
      ),
    );
    const client = createClient({ fetch: fetcher });
    await expect(client.text(endpoint)).resolves.toBe('héllo');
    const blob = await client.blob(endpoint);
    expect(blob.type).toBe('text/plain');
    await expect(blob.text()).resolves.toBe('héllo');
    const buffer = await client.arrayBuffer(endpoint);
    expect(new TextDecoder().decode(buffer)).toBe('héllo');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('merges headers case-insensitively and forwards RequestInit', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('created', { status: 201 }));
    const client = createClient({
      fetch: fetcher,
      baseUrl: new URL('https://api.example.test/v1/'),
      headers: [
        ['Authorization', 'Bearer token'],
        ['X-Shared', 'old'],
      ],
      credentials: 'include',
    });
    await expect(
      client.text('items', {
        method: 'post',
        headers: new Headers({ 'x-shared': 'new', 'Content-Type': 'application/json' }),
        body: '{"value":1}',
        credentials: 'omit',
        mode: 'cors',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        integrity: 'sha256-example',
        keepalive: true,
      }),
    ).resolves.toBe('created');
    const request = getRequest(fetcher);
    expect(request.url).toBe(endpoint);
    expect(request.method).toBe('POST');
    expect(Object.fromEntries(request.headers)).toEqual({
      authorization: 'Bearer token',
      'content-type': 'application/json',
      'x-shared': 'new',
    });
    await expect(request.text()).resolves.toBe('{"value":1}');
    expect(request.credentials).toBe('omit');
    expect(request.mode).toBe('cors');
    expect(request.cache).toBe('no-store');
    expect(request.redirect).toBe('error');
    expect(request.referrerPolicy).toBe('no-referrer');
    expect(request.integrity).toBe('sha256-example');
    expect(request.keepalive).toBe(true);
  });

  it('keeps client credentials and headers when request overrides are absent', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response());
    const client = createClient({
      fetch: fetcher,
      headers: { 'X-Default': 'yes' },
      credentials: 'include',
    });
    await client.request(endpoint);
    expect(getRequest(fetcher).credentials).toBe('include');
    expect(getRequest(fetcher).headers.get('x-default')).toBe('yes');
  });

  it.each(['', 'https://page.example.test/path'])(
    'preserves the explicit referrer on every attempt: %s',
    async (referrer) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValue(new Response('ok'));
      const pending = createClient({ fetch: fetcher, retries: 1 }).text(endpoint, { referrer });
      await vi.advanceTimersByTimeAsync(1000);
      await expect(pending).resolves.toBe('ok');
      expect(getRequest(fetcher).referrer).toBe(referrer);
      expect(getRequest(fetcher, 1).referrer).toBe(referrer);
    },
  );

  /**
  A created client retains its URL, headers, adapter and credential defaults.
  Mutating both nested values and the original options object catches shallow
  snapshots and rereading fetch/credentials; per-call headers stay isolated.
  */
  it('snapshots client defaults and does not mutate caller headers', async () => {
    const headers = new Headers({ 'x-default': 'original' });
    const baseUrl = new URL('https://api.example.test/v1/');
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(new Response()));
    const defaults = {
      headers,
      baseUrl,
      fetch: fetcher,
      credentials: 'include' as RequestCredentials,
    } satisfies ClientOptions;
    const client = createClient(defaults);
    headers.set('x-default', 'changed');
    baseUrl.hostname = 'other.example.test';
    const replacement = vi.fn<typeof fetch>().mockResolvedValue(new Response());
    defaults.fetch = replacement;
    defaults.credentials = 'omit';
    const extra = new Headers({ 'x-extra': 'one' });
    await client.request('items', { headers: extra });
    await client.request('items');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(replacement).not.toHaveBeenCalled();
    expect(getRequest(fetcher).url).toBe(endpoint);
    expect(getRequest(fetcher).headers.get('x-default')).toBe('original');
    expect(getRequest(fetcher, 1).headers.has('x-extra')).toBe(false);
    expect(getRequest(fetcher).credentials).toBe('include');
    expect(getRequest(fetcher, 1).credentials).toBe('include');
    expect([...extra]).toEqual([['x-extra', 'one']]);
  });

  it.each([
    ['items?limit=2', 'https://api.example.test/v1/items?limit=2'],
    ['/health', 'https://api.example.test/health'],
    ['../health', 'https://api.example.test/health'],
    ['https://other.example.test/path', 'https://other.example.test/path'],
  ])('uses standard URL resolution for %s', async (input, expected) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response());
    await createClient({ fetch: fetcher, baseUrl: 'https://api.example.test/v1/' }).request(input);
    expect(getRequest(fetcher).url).toBe(expected);
  });

  /**
  A base path without a trailing slash names a file, not a directory.
  Native sibling resolution catches an unconditional slash added to baseUrl,
  which directory-only examples cannot distinguish from correct behavior.
  */
  it('resolves a relative URL against a base path without a trailing slash', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response());
    await createClient({ fetch: fetcher, baseUrl: 'https://api.example.test/v1' }).request('items');
    expect(getRequest(fetcher).url).toBe('https://api.example.test/items');
  });

  it('preserves empty response semantics from fetch', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(new Response(undefined, { status: 204 })));
    const client = createClient({ fetch: fetcher });
    await expect(client.text(endpoint)).resolves.toBe('');
    await expect(client.json(endpoint)).rejects.toBeInstanceOf(SyntaxError);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('raw request returns at headers without buffering or timing out the body', async () => {
    const { response, stream } = pendingResponse();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const result = await createClient({ fetch: fetcher }).request(endpoint);
    expect(result).toBe(response);
    expect(result.bodyUsed).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getRequest(fetcher).signal.aborted).toBe(false);
    stream.enqueue(new TextEncoder().encode('streamed later'));
    stream.close();
    await expect(result.text()).resolves.toBe('streamed later');
  });
});

describe('retry policy', () => {
  /**
  Adapters may reject with non-Errors, including undefined and other falsy values.
  Check rejection status as well as the exact reason: resolving undefined is
  incorrect too. These cases expose truthy unwrap fallbacks hidden by caller
  cancellation, which takes a different path, and must never cause retries.
  */
  it.each([undefined, null, false, 0, ''] as const)(
    'preserves a non-Error adapter rejection without retrying: %j',
    async (reason) => {
      const fetcher = vi.fn<typeof fetch>().mockRejectedValue(reason);
      const [outcome] = await Promise.allSettled([createClient({ fetch: fetcher }).text(endpoint)]);
      expect(outcome.status).toBe('rejected');
      const error: unknown = outcome.status === 'rejected' ? outcome.reason : outcome;
      expect(error).toBe(reason);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  /**
  Status zero is non-ok, not a successful numeric status below 300.
  Response.error provides a native Node fixture for this branch, also used by
  opaque browser responses; it is not itself a browser opaque-response fixture.
  This detects replacing the ok guard with a numeric HTTP-error threshold.
  */
  it('rejects a non-ok status-zero Response without retrying', async () => {
    const response = Response.error();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const [outcome] = await Promise.allSettled([
      createClient({ fetch: fetcher }).request(endpoint),
    ]);
    const error: unknown = outcome.status === 'rejected' ? outcome.reason : outcome;
    expect(error).toBeInstanceOf(HTTPError);
    expect((error as HTTPError).response).toBe(response);
    expect(response.status).toBe(0);
    expect(response.ok).toBe(false);
    expect(response.bodyUsed).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['name', 'message', 'stack'])(
    'preserves an error with an inaccessible %s without retrying',
    async (name) => {
      const error = new TypeError('Failed to fetch');
      Object.defineProperty(error, name, {
        get: (): never => {
          throw new Error('Property unavailable');
        },
      });
      const fetcher = vi.fn<typeof fetch>().mockRejectedValue(error);
      await expect(createClient({ fetch: fetcher }).text(endpoint)).rejects.toSatisfy(
        (reason: unknown): boolean => reason === error,
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves an uninspectable adapter rejection without retrying', async () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(proxy);
    await expect(createClient({ fetch: fetcher }).text(endpoint)).rejects.toSatisfy(
      (reason: unknown): boolean => reason === proxy,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not interpret retry control errors thrown by an injected fetch', async () => {
    const error = new RetryAbortError('adapter declined');
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(error);
    await expect(createClient({ fetch: fetcher }).text(endpoint)).rejects.toBe(error);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: 'SyntaxError',
      create: (): unknown => runInNewContext('new SyntaxError("Invalid JSON")'),
    },
    {
      name: 'TypeError',
      create: (): unknown => runInNewContext('new TypeError("invalid argument")'),
    },
    { name: 'Error', create: (): unknown => runInNewContext('new Error("adapter failure")') },
  ])(
    'preserves a non-network error from another realm without retrying: $name',
    async ({ create }) => {
      const error = create();
      const response = new Response('unread');
      vi.spyOn(response, 'json').mockRejectedValue(error);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(createClient({ fetch: fetcher }).json(endpoint)).rejects.toBe(error);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('retries a network error from another realm', async () => {
    const error: unknown = runInNewContext('new TypeError("Failed to fetch")');
    expect(error).not.toBeInstanceOf(Error);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(error)
      .mockResolvedValue(new Response('recovered'));
    const pending = createClient({ fetch: fetcher, retries: 1 }).text(endpoint);
    const recovered = expect(pending).resolves.toBe('recovered');
    await vi.advanceTimersByTimeAsync(1000);
    await recovered;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([0, 1])(
    'preserves the original cross-realm network error after %i retries',
    async (retries) => {
      const error: unknown = runInNewContext('new TypeError("Failed to fetch")');
      const fetcher = vi.fn<typeof fetch>().mockRejectedValue(error);
      const pending = createClient({ fetch: fetcher, retries }).text(endpoint);
      const rejected = expect(pending).rejects.toBe(error);
      await vi.runAllTimersAsync();
      await rejected;
      expect(fetcher).toHaveBeenCalledTimes(retries + 1);
    },
  );

  it('retries a body interrupted by a cross-realm network error', async () => {
    const { response, stream } = pendingResponse();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response)
      .mockResolvedValue(Response.json({ recovered: true }));
    const pending = createClient({ fetch: fetcher, retries: 1 }).json(endpoint);
    const recovered = expect(pending).resolves.toEqual({ recovered: true });
    await vi.advanceTimersByTimeAsync(0);
    stream.error(runInNewContext('new TypeError("terminated")'));
    await vi.advanceTimersByTimeAsync(1000);
    await recovered;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    'network error',
    'Failed to fetch',
    'Failed to fetch (api.example.test)',
    'NetworkError when attempting to fetch resource.',
    'The Internet connection appears to be offline.',
    'Network request failed',
    'fetch failed',
    'terminated',
    ' A network error occurred.',
    'Network connection lost',
  ])('recognizes Fetch network errors across runtimes: %s', async (message) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError(message))
      .mockResolvedValue(new Response('ok'));
    const pending = createClient({ fetch: fetcher, retries: 1 }).text(endpoint);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBe('ok');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(['Load failed', 'Load failed (api.example.test)'])(
    'recognizes Safari network errors without a stack: %s',
    async (message) => {
      const error = new TypeError(message);
      Object.defineProperty(error, 'stack', { value: undefined });
      const fetcher = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(error)
        .mockResolvedValue(new Response('ok'));
      const pending = createClient({ fetch: fetcher, retries: 1 }).text(endpoint);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(pending).resolves.toBe('ok');
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  /**
  Default retries must exceed finite budgets with exact bounded backoff and a
  fresh transport signal per attempt. Inspect init.signal itself: constructing
  Requests for comparison creates dependent signals and conceals signal reuse.
  */
  it('retries indefinitely by default with exponential backoff capped at 10 seconds', async () => {
    const times: number[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => {
      times.push(Date.now());
      return times.length <= 12
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(Response.json({ ok: true }));
    });
    const pending = createClient({ fetch: fetcher }).json(endpoint);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(13);
    expect(times.slice(1).map((time, index) => time - (times.at(index) ?? 0))).toEqual([
      1000, 2000, 4000, 8000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000,
    ]);
    const signals = fetcher.mock.calls.map(([, init]) => init?.signal);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    expect(new Set(signals).size).toBe(13);
    expect(signals.every((signal) => signal?.aborted === false)).toBe(true);
  });

  it('uses configurable backoff and request-specific retry limits', async () => {
    const error = new TypeError('fetch failed');
    const times: number[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => {
      times.push(Date.now());
      return Promise.reject(error);
    });
    const pending = createClient({
      fetch: fetcher,
      retries: 0,
      retryDelayMs: 7,
      maxRetryDelayMs: 20,
    }).text(endpoint, { retries: 4 });
    const rejected = expect(pending).rejects.toBe(error);
    await vi.runAllTimersAsync();
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(times.slice(1).map((time, index) => time - (times.at(index) ?? 0))).toEqual([
      7, 14, 20, 20,
    ]);
  });

  it.each(['GET', 'get', 'HEAD', 'head'])('retries the safe method %s', async (method) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('NetworkError when attempting to fetch resource.'))
      .mockResolvedValue(new Response());
    const pending = createClient({ fetch: fetcher, retries: 1 }).request(endpoint, { method });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBeInstanceOf(Response);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(getRequest(fetcher, 1).method).toBe(method.toUpperCase());
  });

  /**
  Unsafe methods are forwarded exactly as native Request normalizes them and
  never replayed. A mixed-case extension token detects blanket uppercasing;
  checking the effective method also catches a wrong transport method override.
  */
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CUSTOM', 'CuStOm'])(
    'never replays %s',
    async (method) => {
      const error = new TypeError('Failed to fetch');
      const fetcher = vi.fn<typeof fetch>().mockRejectedValue(error);
      await expect(
        createClient({ fetch: fetcher }).request(endpoint, { method, retries: 5 }),
      ).rejects.toBe(error);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(getRequest(fetcher).method).toBe(method);
    },
  );

  it('supports disabling retries for an individual read', async () => {
    const error = new TypeError('Failed to fetch');
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(error);
    await expect(createClient({ fetch: fetcher }).request(endpoint, { retries: 0 })).rejects.toBe(
      error,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  /**
  HTTP failures reject once with the exact original, unconsumed Response.
  Strict identity catches cloning that structural toMatchObject missed; reading
  the original body also guards premature consumption and lost error details.
  */
  it.each([400, 401, 403, 404, 408, 429, 500, 502, 503])(
    'does not retry HTTP %i',
    async (status) => {
      const response = new Response('details', { status, statusText: 'Failure' });
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      const [outcome] = await Promise.allSettled([createClient({ fetch: fetcher }).json(endpoint)]);
      const error: unknown = outcome.status === 'rejected' ? outcome.reason : outcome;
      expect(error).toBeInstanceOf(HTTPError);
      expect(error).toMatchObject({
        name: 'HTTPError',
        message: `HTTP ${String(status)}: Failure`,
        response,
      });
      expect((error as HTTPError).response).toBe(response);
      await expect(response.text()).resolves.toBe('details');
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  /**
  Retryability is decided for every failure: a transient error does not make
  a later HTTP or JSON parsing error retryable. A successful third response
  exposes cached classification, while the terminal error/body stay intact.
  */
  it.each(['HTTP error', 'invalid JSON'] as const)(
    'stops on a terminal %s after a transient failure',
    async (failure) => {
      const response =
        failure === 'HTTP error'
          ? new Response('unavailable', { status: 503 })
          : new Response('{broken');
      const fetcher = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(response)
        .mockResolvedValue(Response.json({ unexpected: 'third attempt' }));
      const settled = Promise.allSettled([
        createClient({ fetch: fetcher, retries: 2 }).json(endpoint),
      ]);
      await vi.runAllTimersAsync();
      const [outcome] = await settled;
      const error: unknown = outcome.status === 'rejected' ? outcome.reason : outcome;
      if (failure === 'HTTP error') {
        expect(error).toBeInstanceOf(HTTPError);
        expect((error as HTTPError).response).toBe(response);
        expect(response.bodyUsed).toBe(false);
        await expect(response.text()).resolves.toBe('unavailable');
      } else {
        expect(error).toBeInstanceOf(SyntaxError);
      }
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    new Error('application failure'),
    new TypeError('invalid argument'),
    new SyntaxError('invalid JSON'),
    new DOMException('stopped by transport', 'AbortError'),
  ])('does not retry a non-network error: %s', async (error) => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(error);
    await expect(createClient({ fetch: fetcher }).text(endpoint)).rejects.toBe(error);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not retry malformed JSON', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{broken'));
    await expect(createClient({ fetch: fetcher }).json(endpoint)).rejects.toBeInstanceOf(
      SyntaxError,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  /**
  Every reader must return the successful attempt's value, not merely retry.
  Exact values/types detect empty ArrayBuffers and corrupted JSON/text/Blob
  results introduced only after recovery, which happy-path assertions miss.
  */
  it.each(readers)('retries transport failures while reading $name', async ({ name, read }) => {
    const { response, stream } = pendingResponse();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response)
      .mockResolvedValue(Response.json({ ok: 1 }));
    const pending = read(createClient({ fetch: fetcher, retries: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    stream.error(new TypeError('terminated'));
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    await expectRecoveredBody(name, result);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(getRequest(fetcher, 1).url).toBe(endpoint);
  });

  /**
  Binary recovery must discard the failed body's prefix and preserve every
  byte of the next response, including invalid UTF-8 and its Blob MIME type.
  This detects text round-trips, empty buffers, and mixed attempt bodies.
  */
  it.each(['blob', 'arrayBuffer'] as const)(
    'preserves exact binary bytes after a partial-body retry with %s',
    async (reader) => {
      const bytes = new Uint8Array([0, 255, 128, 195, 40, 13, 10]);
      const { response, stream } = pendingResponse();
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response)
        .mockResolvedValue(
          new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }),
        );
      const client = createClient({ fetch: fetcher, retries: 1 });
      const pending = reader === 'blob' ? client.blob(endpoint) : client.arrayBuffer(endpoint);
      stream.enqueue(new Uint8Array([77, 88, 99]));
      await vi.advanceTimersByTimeAsync(0);
      stream.error(new TypeError('terminated'));
      await vi.advanceTimersByTimeAsync(1000);
      const result = await pending;
      if (reader === 'blob') {
        expect(result).toBeInstanceOf(Blob);
        expect((result as Blob).type).toBe('application/octet-stream');
      } else {
        expect(result).toBeInstanceOf(ArrayBuffer);
      }
      const buffer = result instanceof Blob ? await result.arrayBuffer() : result;
      expect(new Uint8Array(buffer)).toEqual(bytes);
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  /**
  Network failures and attempt deadlines share one finite retry budget.
  Distinct errors and a successful fourth fallback detect a reset budget,
  excluded timeouts, extra attempts, and returning the first failure.
  */
  it('shares one retry budget across network errors and attempt timeouts', async () => {
    const first = new TypeError('Failed to fetch');
    const last = new TypeError('terminated');
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(first)
      .mockImplementationOnce(hangingFetch)
      .mockRejectedValueOnce(last)
      .mockResolvedValue(new Response('unexpected fourth attempt'));
    const pending = createClient({
      fetch: fetcher,
      retries: 2,
      timeoutMs: 10,
      retryDelayMs: 5,
      maxRetryDelayMs: 20,
    }).text(endpoint);
    const settled = Promise.allSettled([pending]);
    await vi.runAllTimersAsync();
    const [outcome] = await settled;
    const error: unknown = outcome.status === 'rejected' ? outcome.reason : outcome;
    expect(error).toBe(last);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(getRequest(fetcher, 1).signal.reason).toBeInstanceOf(TimeoutError);
    expect(getRequest(fetcher, 2).signal.aborted).toBe(false);
  });

  /**
  Overlapping requests on one client own their backoff and finite retry budgets.
  Staggered starts expose hoisted client-level delay/counter state. Assert each
  scheduled attempt before awaiting completion so a delay bug fails explicitly.
  */
  it('keeps overlapping retry schedules and budgets independent', async () => {
    const events: string[] = [];
    const attempts = new Map<string, number>();
    const start = Date.now();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      const count = (attempts.get(path) ?? 0) + 1;
      attempts.set(path, count);
      events.push(`${path}:${String(Date.now() - start)}`);
      const failures = path === '/a' ? 2 : 1;
      return count <= failures
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(new Response(path));
    });
    const client = createClient({ fetch: fetcher, retries: 2 });
    const a = client.text('https://example.test/a');
    await vi.advanceTimersByTimeAsync(250);
    const b = client.text('https://example.test/b', { retries: 1 });
    const outcomes = Promise.allSettled([a, b]);
    await vi.advanceTimersByTimeAsync(749);
    expect(events).toEqual(['/a:0', '/b:250']);
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toEqual(['/a:0', '/b:250', '/a:1000']);
    await vi.advanceTimersByTimeAsync(250);
    expect(events).toEqual(['/a:0', '/b:250', '/a:1000', '/b:1250']);
    await expect(b).resolves.toBe('/b');
    await vi.advanceTimersByTimeAsync(1750);
    expect(events).toEqual(['/a:0', '/b:250', '/a:1000', '/b:1250', '/a:3000']);
    await expect(outcomes).resolves.toEqual([
      { status: 'fulfilled', value: '/a' },
      { status: 'fulfilled', value: '/b' },
    ]);
  });

  /**
  A completed failure or cancellation must not poison a reusable client.
  The next request needs a fresh signal and its full budget to recover once.
  This detects retained errors/abort state and counters shared between calls.
  */
  it.each(['exhausted', 'cancelled'] as const)(
    'reuses one client after a completed %s operation',
    async (failure) => {
      const controller = new AbortController();
      const last = new TypeError('terminated');
      const fetcher = vi.fn<typeof fetch>();
      if (failure === 'exhausted') {
        fetcher.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockRejectedValueOnce(last);
      } else {
        fetcher.mockImplementationOnce(hangingFetch);
      }
      fetcher
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(new Response('fresh operation'));
      const client = createClient({
        fetch: fetcher,
        retries: 1,
        retryDelayMs: 5,
        maxRetryDelayMs: 10,
      });
      const stopped = Promise.allSettled([client.text(endpoint, { signal: controller.signal })]);
      if (failure === 'cancelled') {
        controller.abort('navigation');
      }
      await vi.runAllTimersAsync();
      const [outcome] = await stopped;
      expect(outcome.status).toBe('rejected');
      const error: unknown = outcome.status === 'rejected' ? outcome.reason : outcome;
      expect(error).toBe(failure === 'cancelled' ? 'navigation' : last);
      const restarted = Promise.allSettled([client.text(endpoint)]);
      await vi.runAllTimersAsync();
      await expect(restarted).resolves.toEqual([{ status: 'fulfilled', value: 'fresh operation' }]);
      expect(fetcher).toHaveBeenCalledTimes(failure === 'cancelled' ? 3 : 4);
      expect(getRequest(fetcher, -1).signal.aborted).toBe(false);
    },
  );
});

describe('attempt deadlines', () => {
  /**
  Two pending attempts on one client keep independent controllers and deadlines:
  A starts at t0 with 10 ms; B at t5 with 50 ms, so it stays live until t55.
  Signal states and exact timeout reasons detect shared controller/timer state
  that redirects A's deadline into B. Caller cleanup also releases failed probes.
  */
  it('keeps deadlines independent for overlapping pending attempts', async () => {
    const firstCaller = new AbortController();
    const secondCaller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(hangingFetch);
    const client = createClient({ fetch: fetcher, retries: 0 });
    const first = Promise.allSettled([
      client.text(endpoint, { timeoutMs: 10, signal: firstCaller.signal }),
    ]);
    await vi.advanceTimersByTimeAsync(5);
    const second = Promise.allSettled([
      client.text(endpoint, { timeoutMs: 50, signal: secondCaller.signal }),
    ]);
    try {
      await vi.advanceTimersByTimeAsync(5);
      const firstSignal = getRequest(fetcher).signal;
      const secondSignal = getRequest(fetcher, 1).signal;
      expect(firstSignal.aborted).toBe(true);
      expect(secondSignal.aborted).toBe(false);
      const [firstOutcome] = await first;
      expect(firstOutcome.status).toBe('rejected');
      const firstError: unknown =
        firstOutcome.status === 'rejected' ? firstOutcome.reason : firstOutcome;
      expect(firstError).toBe(firstSignal.reason);
      expect(firstError).toBeInstanceOf(TimeoutError);
      expect(firstError).toMatchObject({ timeoutMs: 10 });
      await vi.advanceTimersByTimeAsync(44);
      expect(secondSignal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(secondSignal.aborted).toBe(true);
      const [secondOutcome] = await second;
      expect(secondOutcome.status).toBe('rejected');
      const secondError: unknown =
        secondOutcome.status === 'rejected' ? secondOutcome.reason : secondOutcome;
      expect(secondError).toBe(secondSignal.reason);
      expect(secondError).toBeInstanceOf(TimeoutError);
      expect(secondError).toMatchObject({ timeoutMs: 50 });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      firstCaller.abort();
      secondCaller.abort();
      await Promise.all([first, second]);
    }
  });

  it('times out at the default 20 seconds even if fetch ignores cancellation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(hangingFetch);
    const pending = createClient({ fetch: fetcher, retries: 0 }).request(endpoint);
    const rejected = expect(pending).rejects.toMatchObject({
      name: 'TimeoutError',
      timeoutMs: 20_000,
      message: 'Request attempt timed out after 20000 ms',
    });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(getRequest(fetcher).signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(getRequest(fetcher).signal.aborted).toBe(true);
    expect(getRequest(fetcher).signal.reason).toBeInstanceOf(TimeoutError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retries timed-out reads with a fresh deadline and signal', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(hangingFetch)
      .mockResolvedValue(new Response('recovered'));
    const client = createClient({ fetch: fetcher, timeoutMs: 50 });
    const pending = client.text(endpoint, { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(99);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(getRequest(fetcher).signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(getRequest(fetcher).signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe('recovered');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(getRequest(fetcher, 1).signal.aborted).toBe(false);
  });

  it('uses the configured default deadline for every attempt', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(hangingFetch);
    const pending = createClient({ fetch: fetcher, timeoutMs: 10, retries: 1 }).text(endpoint);
    const rejected = expect(pending).rejects.toMatchObject({ timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9);
    expect(getRequest(fetcher, 1).signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(getRequest(fetcher, 1).signal.aborted).toBe(true);
  });

  /**
  A body deadline must recover the exact value from the fresh response for
  every reader. Checking the result detects recovery-only data corruption;
  checking both signals detects reusing the already timed-out attempt.
  */
  it.each(readers)('includes $name body consumption in the deadline', async ({ name, read }) => {
    const { response, stream } = pendingResponse();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response)
      .mockResolvedValue(Response.json({ ok: 1 }));
    const pending = read(createClient({ fetch: fetcher, timeoutMs: 10 }));
    await vi.advanceTimersByTimeAsync(10);
    expect(getRequest(fetcher).signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    await expectRecoveredBody(name, result);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(getRequest(fetcher, 1).signal.aborted).toBe(false);
    stream.close();
  });

  /**
  Successful headers do not make a POST safe to replay when its body fails.
  Both transport failure and body timeout must reject once with the original
  failure. A successful fallback exposes accidental retries as data delivery.
  */
  it.each(['network error', 'timeout'] as const)(
    'never replays a POST after a response-body %s',
    async (failure) => {
      const { response, stream } = pendingResponse();
      const error = new TypeError('terminated');
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response)
        .mockResolvedValue(new Response('unsafe replay'));
      const pending = createClient({ fetch: fetcher, retries: 1, timeoutMs: 10 }).text(endpoint, {
        method: 'POST',
        body: 'create item',
      });
      const settled = Promise.allSettled([pending]);
      await vi.advanceTimersByTimeAsync(0);
      if (failure === 'network error') {
        stream.error(error);
      } else {
        await vi.advanceTimersByTimeAsync(10);
        stream.close();
      }
      await vi.advanceTimersByTimeAsync(1000);
      const [outcome] = await settled;
      const result: unknown = outcome.status === 'rejected' ? outcome.reason : outcome;
      if (failure === 'network error') {
        expect(result).toBe(error);
      } else {
        expect(result).toBeInstanceOf(TimeoutError);
        expect(result).toBe(getRequest(fetcher).signal.reason);
      }
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('does not retry writes even after a timeout', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(hangingFetch);
    const pending = createClient({ fetch: fetcher, timeoutMs: 10 }).text(endpoint, {
      method: 'POST',
      body: 'data',
    });
    const rejected = expect(pending).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('never consumes a response arriving after its deadline', async () => {
    const deferred = Promise.withResolvers<Response>();
    const response = Response.json({ stale: true });
    const read = vi.spyOn(response, 'json');
    const fetcher = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(deferred.promise)
      .mockResolvedValue(Response.json({ fresh: true }));
    const pending = createClient({ fetch: fetcher, timeoutMs: 10 }).json(endpoint);
    await vi.advanceTimersByTimeAsync(10);
    deferred.resolve(response);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({ fresh: true });
    expect(read).not.toHaveBeenCalled();
  });
});

describe('caller cancellation', () => {
  /**
  Active cancellation preserves every falsy caller reason, not a fallback Error.
  Cancelling a hanging fetch exercises the unwrap path after p-retry; an already
  aborted input would miss it. Exact values and no later attempts catch truthy
  fallback normalization and accidental retries of caller cancellation.
  */
  it.each([false, 0, '', null] as const)(
    'preserves the falsy active caller cancellation reason %j',
    async (reason) => {
      const controller = new AbortController();
      const fetcher = vi.fn<typeof fetch>().mockImplementation(hangingFetch);
      const settled = Promise.allSettled([
        createClient({ fetch: fetcher }).text(endpoint, { signal: controller.signal }),
      ]);
      controller.abort(reason);
      const [outcome] = await settled;
      const error: unknown = outcome.status === 'rejected' ? outcome.reason : outcome;
      expect(error).toBe(reason);
      expect(getRequest(fetcher).signal.reason).toBe(reason);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('honors a signal defined by a RequestInit prototype getter', async () => {
    class CancelOptions implements RequestOptions {
      get signal(): AbortSignal {
        return AbortSignal.abort('cancelled');
      }
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(createClient({ fetch: fetcher }).text(endpoint, new CancelOptions())).rejects.toBe(
      'cancelled',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves a caller abort reason that cannot be inspected', async () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(hangingFetch);
    const pending = createClient({ fetch: fetcher }).text(endpoint, { signal: controller.signal });
    const rejected = expect(pending).rejects.toSatisfy(
      (reason: unknown): boolean => reason === proxy,
    );
    controller.abort(proxy);
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(
    [0, 1, 2, 3, 4, 5, 6, 7, 8].flatMap((steps) => [
      { steps, reason: 'navigation' },
      { steps, reason: new Error('navigation') },
    ]),
  )(
    'preserves cancellation during response resolution after $steps microtasks ($reason)',
    async ({ steps, reason }) => {
      const controller = new AbortController();
      function cancelAfter(remaining: number): void {
        if (remaining === 0) {
          controller.abort(reason);
        } else {
          queueMicrotask(() => {
            cancelAfter(remaining - 1);
          });
        }
      }
      const fetcher = vi.fn<typeof fetch>().mockImplementation(() => {
        cancelAfter(steps);
        return Promise.resolve(new Response('completed'));
      });
      try {
        const result = await createClient({ fetch: fetcher }).text(endpoint, {
          signal: controller.signal,
        });
        expect(result).toBe('completed');
      } catch (error) {
        expect(error).toBe(reason);
      }
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('does not acquire a Node upload iterator when the caller has already cancelled', async () => {
    const acquire = vi.fn(() => ({
      next: (): Promise<IteratorResult<Uint8Array>> =>
        Promise.resolve({ done: true, value: undefined }),
    }));
    const body = { [Symbol.asyncIterator]: acquire };
    const fetcher = vi.fn<typeof fetch>();
    const client = createClient({ fetch: fetcher });
    // Node's RequestInit accepts AsyncIterable uploads; the DOM type project does not.
    const pending: unknown = Reflect.apply(client.request, client, [
      endpoint,
      {
        method: 'POST',
        body,
        duplex: 'half',
        signal: AbortSignal.abort('navigation'),
      },
    ]);
    await expect(pending).rejects.toBe('navigation');
    expect(acquire).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('releases a Node upload if its iterator cancels the operation during acquisition', async () => {
    const source = new EventTarget();
    const listener = vi.fn();
    const controller = new AbortController();
    const release = vi.fn((): Promise<IteratorResult<Uint8Array>> => {
      source.removeEventListener('data', listener);
      return Promise.resolve({ done: true, value: undefined });
    });
    const body = {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        source.addEventListener('data', listener);
        controller.abort('source closed');
        return {
          next: (): Promise<IteratorResult<Uint8Array>> =>
            Promise.resolve({ done: true, value: undefined }),
          return: release,
        };
      },
    };
    const fetcher = vi.fn<typeof fetch>(fetch);
    const client = createClient({ fetch: fetcher });
    const pending: unknown = Reflect.apply(client.request, client, [
      endpoint,
      {
        method: 'POST',
        body,
        duplex: 'half',
        signal: controller.signal,
      },
    ]);
    await expect(pending).rejects.toBe('source closed');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    source.dispatchEvent(new Event('data'));
    expect(listener).not.toHaveBeenCalled();
  });

  it.each([new Error('navigation'), 'custom reason', 42, undefined])(
    'preserves a pre-aborted signal reason: %s',
    async (reason) => {
      const controller = new AbortController();
      controller.abort(reason);
      const fetcher = vi.fn<typeof fetch>();
      await expect(
        createClient({ fetch: fetcher }).text(endpoint, { signal: controller.signal }),
      ).rejects.toBe(controller.signal.reason);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('cancels during fetch even when the transport ignores the signal', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(hangingFetch);
    const pending = createClient({ fetch: fetcher }).json(endpoint, { signal: controller.signal });
    const rejected = expect(pending).rejects.toBe('left page');
    controller.abort('left page');
    await rejected;
    expect(getRequest(fetcher).signal.aborted).toBe(true);
    expect(getRequest(fetcher).signal.reason).toBe('left page');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('cancels during response body consumption', async () => {
    const { response, stream } = pendingResponse();
    const controller = new AbortController();
    const reason = new Error('stop reading');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const pending = createClient({ fetch: fetcher }).text(endpoint, { signal: controller.signal });
    const rejected = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(reason);
    await rejected;
    stream.close();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('cancels backoff without waiting or starting another attempt', async () => {
    const controller = new AbortController();
    const reason = new Error('stop');
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'));
    const pending = createClient({ fetch: fetcher }).request(endpoint, {
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetcher).toHaveBeenCalledTimes(1);
    controller.abort(reason);
    await rejected;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('isolates concurrent requests and their abort signals', async () => {
    const controller = new AbortController();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(hangingFetch)
      .mockResolvedValue(new Response('other request'));
    const client = createClient({ fetch: fetcher });
    const first = client.text(endpoint, { signal: controller.signal });
    const rejected = expect(first).rejects.toBe('cancel first');
    await expect(client.text(endpoint)).resolves.toBe('other request');
    controller.abort('cancel first');
    await rejected;
    expect(getRequest(fetcher, 1).signal.aborted).toBe(false);
  });
});

describe('input validation', () => {
  it.each(['GET', 'HEAD'])(
    'rejects even an empty body for %s with a useful error',
    async (method) => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(
        createClient({ fetch: fetcher }).request(endpoint, { method, body: '' }),
      ).rejects.toThrow('GET and HEAD requests cannot have a body');
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('accepts an explicit null body for a read', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
    await expect(createClient({ fetch: fetcher }).text(endpoint, { body: null })).resolves.toBe(
      'ok',
    );
  });

  it.each(['ftp://example.test/', 'data:text/plain,hello'])(
    'validates the protocol before acquiring a Node upload iterator: %s',
    async (input) => {
      const acquire = vi.fn(() => ({
        next: (): Promise<IteratorResult<Uint8Array>> =>
          Promise.resolve({ done: true, value: undefined }),
      }));
      const fetcher = vi.fn<typeof fetch>();
      const client = createClient({ fetch: fetcher });
      const pending: unknown = Reflect.apply(client.request, client, [
        input,
        {
          method: 'POST',
          body: { [Symbol.asyncIterator]: acquire },
          duplex: 'half',
        },
      ]);
      await expect(pending).rejects.toThrow('Only HTTP and HTTPS URLs are supported');
      expect(acquire).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each(['retries', 'timeoutMs', 'retryDelayMs', 'maxRetryDelayMs'])(
    'rejects null instead of silently defaulting %s in JavaScript',
    (name) => {
      expect(() => {
        Reflect.apply(createClient, undefined, [{ [name]: null }]);
      }).toThrow(RangeError);
    },
  );

  it.each(['timeoutMs', 'retryDelayMs', 'maxRetryDelayMs'] as const)(
    'rejects invalid %s defaults',
    (name) => {
      for (const value of [0, -1, 1.5, NaN, Infinity, 2_147_483_648]) {
        expect(() => createClient({ [name]: value })).toThrow(
          `${name} must be an integer between 1 and 2147483647`,
        );
      }
    },
  );

  it('accepts inclusive timer boundaries', () => {
    expect(() =>
      createClient({ timeoutMs: 1, retryDelayMs: 1, maxRetryDelayMs: 2_147_483_647 }),
    ).not.toThrow();
    expect(() =>
      createClient({
        timeoutMs: 2_147_483_647,
        retryDelayMs: 2_147_483_647,
        maxRetryDelayMs: 2_147_483_647,
      }),
    ).not.toThrow();
  });

  it('rejects inverted backoff bounds but allows equal bounds', () => {
    expect(() => createClient({ retryDelayMs: 11, maxRetryDelayMs: 10 })).toThrow(
      'retryDelayMs must not exceed maxRetryDelayMs',
    );
    expect(() => createClient({ retryDelayMs: 10, maxRetryDelayMs: 10 })).not.toThrow();
  });

  it.each([-1, 1.5, NaN, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid retries %s',
    async (retries) => {
      expect(() => createClient({ retries })).toThrow(
        'retries must be a non-negative safe integer or Infinity',
      );
      const fetcher = vi.fn<typeof fetch>();
      await expect(createClient({ fetch: fetcher }).request(endpoint, { retries })).rejects.toThrow(
        'retries must be a non-negative safe integer or Infinity',
      );
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([0, 1, Number.MAX_SAFE_INTEGER, Infinity])('accepts retries %s', (retries) => {
    expect(() => createClient({ retries })).not.toThrow();
  });

  it('validates request deadlines before making a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      createClient({ fetch: fetcher }).request(endpoint, { timeoutMs: 0 }),
    ).rejects.toThrow('timeoutMs must be an integer between 1 and 2147483647');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['https://api.example.test/', { method: 'GET', body: 'forbidden' }],
    ['https://api.example.test/', { headers: { 'bad header': 'value' } }],
    ['https://api.example.test/', { method: 'bad method' }],
    ['https://user:password@api.example.test/', {}],
    ['not a URL', {}],
  ] satisfies [string, RequestOptions][])(
    'rejects invalid Request input before retrying: %s %o',
    async (input, options) => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(createClient({ fetch: fetcher }).request(input, options)).rejects.toBeInstanceOf(
        TypeError,
      );
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each(['ftp://example.test/', 'data:text/plain,hello'])(
    'rejects unsupported protocols: %s',
    async (input) => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(createClient({ fetch: fetcher }).request(input)).rejects.toThrow(
        'Only HTTP and HTTPS URLs are supported',
      );
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('validates base URLs at client construction', () => {
    expect(() => createClient({ baseUrl: '/relative' })).toThrow(TypeError);
  });
});
