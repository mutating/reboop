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
