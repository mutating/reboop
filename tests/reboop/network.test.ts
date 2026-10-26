import { once } from 'node:events';
import { createServer } from 'node:http';
import type { RequestListener, Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { createClient, HTTPError } from '../../packages/reboop/src/index.js';

describe('native fetch against a local HTTP server', () => {
  let server: Server;
  let origin: string;
  let handler: Mock<RequestListener>;

  beforeEach(async () => {
    handler = vi.fn<RequestListener>();
    server = createServer(handler);
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected a TCP server address');
    }
    origin = `http://127.0.0.1:${String(address.port)}/`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    const closed = once(server, 'close');
    server.close();
    await closed;
  });

  function networkClient(): ReturnType<typeof createClient> {
    return createClient({ baseUrl: origin, retries: 2, timeoutMs: 500, retryDelayMs: 5 });
  }

  function receiveUpload(): Promise<{
    method: string | undefined;
    contentType: string | undefined;
    bytes: Uint8Array<ArrayBuffer>;
  }> {
    const received = Promise.withResolvers<{
      method: string | undefined;
      contentType: string | undefined;
      bytes: Uint8Array<ArrayBuffer>;
    }>();
    handler.mockImplementation((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer): void => {
        chunks.push(chunk);
      });
      request.on('end', (): void => {
        received.resolve({
          method: request.method,
          contentType: request.headers['content-type'],
          bytes: Uint8Array.from(Buffer.concat(chunks)),
        });
        response.end('uploaded');
      });
    });
    return received.promise;
  }

  /**
  Already escaped paths/query values must reach the server byte-for-byte, while
  fragments remain local. This guards signed URLs against double encoding or
  decoding reserved slashes/pluses and keeps repeated query parameters intact.
  */
  it('preserves escaped URL bytes and omits fragments on the wire', async () => {
    handler.mockImplementation((request, response) => {
      response.end(request.url);
    });
    await expect(networkClient().text('/file%20name?q=a%2Fb%2B&q=%D0%96#section')).resolves.toBe(
      '/file%20name?q=a%2Fb%2B&q=%D0%96',
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  /**
  Fetch must generate the multipart boundary and preserve form fields/files.
  Parsing the actual upload detects imposed JSON headers, body coercion,
  missing filenames/MIME types, and corruption of non-UTF-8 file bytes.
  A nondefault file MIME distinguishes preserved metadata from multipart's
  application/octet-stream fallback, which masked MIME loss in the challenge.
  */
  it('uploads FormData with native multipart headers and exact file bytes', async () => {
    const received = receiveUpload();
    const bytes = new Uint8Array([0, 255, 128, 10]);
    const body = new FormData();
    body.append('label', 'héllo');
    body.append('file', new Blob([bytes], { type: 'application/x-reboop-binary' }), 'sample.bin');
    await expect(networkClient().text('/upload', { method: 'POST', body })).resolves.toBe(
      'uploaded',
    );
    const upload = await received;
    expect(upload.method).toBe('POST');
    expect(upload.contentType).toMatch(/^multipart\/form-data; boundary=.+$/u);
    const form = await new Response(upload.bytes, {
      headers: { 'Content-Type': upload.contentType ?? '' },
    }).formData();
    expect(form.get('label')).toBe('héllo');
    const file = form.get('file');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('sample.bin');
    expect((file as File).type).toBe('application/x-reboop-binary');
    expect(new Uint8Array(await (file as File).arrayBuffer())).toEqual(bytes);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  /**
  Native URL encoding must retain duplicate keys, Unicode and reserved bytes.
  Exact wire bytes and Content-Type catch JSON headers, object coercion,
  double encoding, and conversions that silently drop duplicate parameters.
  */
  it('uploads URLSearchParams with native encoding and duplicate keys', async () => {
    const received = receiveUpload();
    const body = new URLSearchParams([
      ['key', 'a &+'],
      ['key', 'Ж'],
    ]);
    await expect(networkClient().text('/upload', { method: 'POST', body })).resolves.toBe(
      'uploaded',
    );
    const upload = await received;
    expect(upload.method).toBe('POST');
    expect(upload.contentType).toBe('application/x-www-form-urlencoded;charset=UTF-8');
    expect(new TextDecoder().decode(upload.bytes)).toBe('key=a+%26%2B&key=%D0%96');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  /**
  A typed-array view uploads only its selected byte range without a MIME type.
  Sentinel bytes outside the view expose forwarding its backing buffer;
  invalid UTF-8 exposes text serialization or replacement-character loss.
  */
  it('uploads only the selected typed-array view without inventing Content-Type', async () => {
    const received = receiveUpload();
    const body = new Uint8Array([111, 255, 0, 128, 222]).subarray(1, 4);
    await expect(networkClient().text('/upload', { method: 'POST', body })).resolves.toBe(
      'uploaded',
    );
    const upload = await received;
    expect(upload.method).toBe('POST');
    expect(upload.contentType).toBeUndefined();
    expect(upload.bytes).toEqual(new Uint8Array([255, 0, 128]));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  /**
  Node's streaming BodyInit extension must open its source once and send all
  chunks in order. Wire bytes, iterator counts and one POST detect loss of
  duplex/body, double acquisition during preparation, and truncated uploads.
  */
  it('uploads a Node async iterable once with duplex half and all chunks', async () => {
    const received = receiveUpload();
    const next = vi
      .fn<() => Promise<IteratorResult<Uint8Array, undefined>>>()
      .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('first:') })
      .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('second') })
      .mockResolvedValue({ done: true, value: undefined });
    const acquire = vi.fn((): AsyncIterator<Uint8Array, undefined> => ({ next }));
    const body: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: acquire };
    const client = networkClient();
    const pending: unknown = Reflect.apply(client.text, client, [
      '/upload',
      { method: 'POST', body, duplex: 'half' },
    ]);
    await expect(pending).resolves.toBe('uploaded');
    const upload = await received;
    expect(upload.method).toBe('POST');
    expect(new TextDecoder().decode(upload.bytes)).toBe('first:second');
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(3);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  /**
  Preserve native default/manual/error redirect policies and Response metadata.
  Omitting the default option exposes forced manual redirects; manual/error
  must never hit the target. The untouched manual body remains caller-readable.
  retries:0 isolates redirect:error, which Fetch reports as a network TypeError.
  */
  it.each(['default', 'manual', 'error'] as const)(
    'preserves the native %s redirect policy',
    async (policy) => {
      const routes: (string | undefined)[] = [];
      handler.mockImplementation((request, response) => {
        routes.push(request.url);
        if (request.url === '/redirect') {
          response.writeHead(302, { Location: '/target' });
          response.end('redirect body');
        } else {
          response.end('target body');
        }
      });
      const pending = networkClient().request(
        '/redirect',
        policy === 'default' ? {} : { redirect: policy, retries: 0 },
      );
      if (policy === 'default') {
        const response = await pending;
        expect(response.status).toBe(200);
        expect(response.redirected).toBe(true);
        expect(response.url).toBe(new URL('/target', origin).href);
        await expect(response.text()).resolves.toBe('target body');
        expect(routes).toEqual(['/redirect', '/target']);
      } else if (policy === 'manual') {
        const [outcome] = await Promise.allSettled([pending]);
        const error: unknown = outcome.status === 'rejected' ? outcome.reason : outcome;
        expect(error).toBeInstanceOf(HTTPError);
        const response = (error as HTTPError).response;
        expect(response.status).toBe(302);
        expect(response.redirected).toBe(false);
        expect(response.headers.get('location')).toBe('/target');
        expect(response.bodyUsed).toBe(false);
        await expect(response.text()).resolves.toBe('redirect body');
        expect(routes).toEqual(['/redirect']);
      } else {
        await expect(pending).rejects.toBeInstanceOf(TypeError);
        expect(routes).toEqual(['/redirect']);
      }
    },
  );

  it('sends the same normalized method used to determine retry safety', async () => {
    const methods: (string | undefined)[] = [];
    handler.mockImplementation((request, response) => {
      methods.push(request.method);
      if (methods.length === 1) {
        request.socket.destroy();
      } else {
        response.end('recovered');
      }
    });
    const convert = vi.fn().mockReturnValueOnce('GET').mockReturnValue('POST');
    const client = networkClient();
    // JavaScript Fetch accepts stringifiable methods, even though the TS type is string.
    const pending: unknown = Reflect.apply(client.text, client, [
      '/items',
      { method: { toString: convert } },
    ]);
    await expect(pending).resolves.toBe('recovered');
    expect(methods).toEqual(['GET', 'GET']);
    expect(convert).toHaveBeenCalledTimes(1);
  });

  it('recovers from a connection reset before headers', async () => {
    handler
      .mockImplementationOnce((request) => {
        request.socket.destroy();
      })
      .mockImplementation((_request, response) => {
        response.end('recovered');
      });
    await expect(networkClient().text('/items')).resolves.toBe('recovered');
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('recovers when Fetch terminates a body with invalid content encoding', async () => {
    handler
      .mockImplementationOnce((_request, response) => {
        response.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': '3' });
        response.end('bad');
      })
      .mockImplementation((_request, response) => {
        response.end('recovered');
      });
    await expect(networkClient().text('/items')).resolves.toBe('recovered');
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('retries a truncated response body after receiving headers', async () => {
    handler
      .mockImplementationOnce((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
        response.write('{"partial":');
        setTimeout(() => {
          response.destroy();
        }, 30);
      })
      .mockImplementation((_request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end('{"complete":true}');
      });
    const statuses: number[] = [];
    const client = createClient({
      baseUrl: origin,
      retries: 2,
      timeoutMs: 500,
      retryDelayMs: 5,
      fetch: async (input, init): Promise<Response> => {
        const response = await fetch(input, init);
        statuses.push(response.status);
        return response;
      },
    });
    await expect(client.json('/items')).resolves.toEqual({ complete: true });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual([200, 200]);
  });

  it('times out a server that accepts the request but sends no headers', async () => {
    handler
      .mockImplementationOnce(() => {
        // Keep the socket open without responding.
      })
      .mockImplementation((_request, response) => {
        response.end('after stalled headers');
      });
    await expect(networkClient().text('/items', { timeoutMs: 100 })).resolves.toBe(
      'after stalled headers',
    );
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('times out a server that sends headers but never completes its body', async () => {
    handler
      .mockImplementationOnce((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{');
      })
      .mockImplementation((_request, response) => {
        response.end('{"afterStall":true}');
      });
    await expect(networkClient().json('/items', { timeoutMs: 100 })).resolves.toEqual({
      afterStall: true,
    });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('does not replay a write whose response is lost', async () => {
    handler.mockImplementation((request) => {
      request.socket.destroy();
    });
    await expect(
      networkClient().text('/items', { method: 'POST', body: '{"create":true}' }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('exposes the error response without retrying HTTP errors', async () => {
    handler.mockImplementation((_request, response) => {
      response.writeHead(503, { 'Retry-After': '1' });
      response.end('unavailable');
    });
    const pending = networkClient().request('/items');
    await expect(pending).rejects.toBeInstanceOf(HTTPError);
    try {
      await pending;
    } catch (error) {
      if (!(error instanceof HTTPError)) {
        throw error;
      }
      expect(error.response.status).toBe(503);
      expect(error.response.headers.get('retry-after')).toBe('1');
      await expect(error.response.text()).resolves.toBe('unavailable');
    }
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('aborts a native fetch body without another attempt', async () => {
    handler.mockImplementation((_request, response) => {
      response.writeHead(200);
      response.write('still streaming');
    });
    const headers = Promise.withResolvers<undefined>();
    const controller = new AbortController();
    const client = createClient({
      baseUrl: origin,
      fetch: async (input, init): Promise<Response> => {
        const response = await fetch(input, init);
        headers.resolve(undefined);
        return response;
      },
    });
    const pending = client.text('/items', { signal: controller.signal });
    const rejected = expect(pending).rejects.toBe('navigation');
    await headers.promise;
    controller.abort('navigation');
    await rejected;
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

/**
The documented AbortSignal.timeout recipe bounds backoff as well as attempts.
Native timers and an immediately rejected adapter isolate signal behavior from
socket timing. Exact reason identity and one call catch replaced timeout errors,
retrying a caller timeout, or leaving backoff detached from cancellation.
*/
it('uses AbortSignal.timeout as an overall deadline during retry backoff', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValue(new Response('unexpected retry after cancellation'));
  const signal = AbortSignal.timeout(30);
  const client = createClient({ fetch: fetcher, retryDelayMs: 100, timeoutMs: 200 });
  const [outcome] = await Promise.allSettled([client.text('https://example.test/', { signal })]);
  const failure: unknown = outcome.status === 'rejected' ? outcome.reason : outcome;
  expect(signal.aborted).toBe(true);
  expect(signal.reason).toBeInstanceOf(DOMException);
  expect(signal.reason).toMatchObject({ name: 'TimeoutError' });
  expect(failure).toBe(signal.reason);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
