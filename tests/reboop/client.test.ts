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
  return input;
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

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('requests and response readers', () => {
  it('uses global fetch with the native defaults and returns the original response', async () => {
    const response = new Response('hello');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetcher);
    const client = createClient();
    await expect(client.request(endpoint)).resolves.toBe(response);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(expect.any(Request));
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

  it('snapshots client defaults and does not mutate caller headers', async () => {
    const headers = new Headers({ 'x-default': 'original' });
    const baseUrl = new URL('https://api.example.test/v1/');
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(new Response()));
    const defaults = {
      headers,
      baseUrl,
      fetch: fetcher,
      credentials: 'include',
    } satisfies ClientOptions;
    const client = createClient(defaults);
    headers.set('x-default', 'changed');
    baseUrl.hostname = 'other.example.test';
    const extra = new Headers({ 'x-extra': 'one' });
    await client.request('items', { headers: extra });
    await client.request('items');
    expect(getRequest(fetcher).url).toBe(endpoint);
    expect(getRequest(fetcher).headers.get('x-default')).toBe('original');
    expect(getRequest(fetcher, 1).headers.has('x-extra')).toBe(false);
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
    const signals = fetcher.mock.calls.map((_call, index) => getRequest(fetcher, index).signal);
    expect(new Set(signals).size).toBe(13);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
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

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CUSTOM'])(
    'never replays %s',
    async (method) => {
      const error = new TypeError('Failed to fetch');
      const fetcher = vi.fn<typeof fetch>().mockRejectedValue(error);
      await expect(
        createClient({ fetch: fetcher }).request(endpoint, { method, retries: 5 }),
      ).rejects.toBe(error);
      expect(fetcher).toHaveBeenCalledTimes(1);
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

  it.each([400, 401, 403, 404, 408, 429, 500, 502, 503])(
    'does not retry HTTP %i',
    async (status) => {
      const response = new Response('details', { status, statusText: 'Failure' });
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      const pending = createClient({ fetch: fetcher }).json(endpoint);
      await expect(pending).rejects.toBeInstanceOf(HTTPError);
      await expect(pending).rejects.toMatchObject({
        name: 'HTTPError',
        message: `HTTP ${String(status)}: Failure`,
        response,
      });
      await expect(response.text()).resolves.toBe('details');
      expect(fetcher).toHaveBeenCalledTimes(1);
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
    if (name === 'json') {
      expect(result).toEqual({ ok: 1 });
    } else if (name === 'text') {
      expect(result).toBe('{"ok":1}');
    } else if (result instanceof Blob) {
      await expect(result.text()).resolves.toBe('{"ok":1}');
    } else {
      expect(result).toBeInstanceOf(ArrayBuffer);
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(getRequest(fetcher, 1).url).toBe(endpoint);
  });
});

describe('attempt deadlines', () => {
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

  it.each(readers)('includes $name body consumption in the deadline', async ({ read }) => {
    const { response, stream } = pendingResponse();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response)
      .mockResolvedValue(Response.json({ ok: 1 }));
    const pending = read(createClient({ fetch: fetcher, timeoutMs: 10 }));
    await vi.advanceTimersByTimeAsync(10);
    expect(getRequest(fetcher).signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(fetcher).toHaveBeenCalledTimes(2);
    stream.close();
  });

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
