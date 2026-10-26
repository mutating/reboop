import isNetworkError from 'is-network-error';
import pRetry from 'p-retry';
import { abortable } from './abortable.js';
import { prepareRequest } from './prepare-request.js';

export interface ClientOptions {
  readonly baseUrl?: string | URL;
  readonly headers?: RequestInit['headers'];
  readonly credentials?: RequestInit['credentials'];
  /**
  Additional attempts after a failed GET/HEAD. Defaults to Infinity.
  */
  readonly retries?: number;
  /**
  Deadline for each attempt, including body consumption. Defaults to 20,000 ms.
  */
  readonly timeoutMs?: number;
  /**
  Exponential backoff starts here. Defaults to 1,000 ms.
  */
  readonly retryDelayMs?: number;
  /**
  Backoff is capped here. Defaults to 10,000 ms.
  */
  readonly maxRetryDelayMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export interface RequestOptions extends RequestInit {
  readonly retries?: number;
  readonly timeoutMs?: number;
}

export interface Client {
  /**
  Resolves at response headers; subsequent body reads are outside the retry deadline.
  */
  request: (input: string | URL, options?: RequestOptions) => Promise<Response>;
  /**
  Read/decode a successful response inside the attempt deadline and retry scope.
  The reader may run again for GET/HEAD; keep it free of external side effects
  and return/await all response work that should be protected.
  */
  read: <T>(
    input: string | URL,
    reader: (response: Response) => T | Promise<T>,
    options?: RequestOptions,
  ) => Promise<T>;
  /**
  The generic is a type assertion, not runtime schema validation.
  */
  json: <T = unknown>(input: string | URL, options?: RequestOptions) => Promise<T>;
  text: (input: string | URL, options?: RequestOptions) => Promise<string>;
  blob: (input: string | URL, options?: RequestOptions) => Promise<Blob>;
  arrayBuffer: (input: string | URL, options?: RequestOptions) => Promise<ArrayBuffer>;
}

export class HTTPError extends Error {
  override readonly name = 'HTTPError';

  constructor(readonly response: Response) {
    super(`HTTP ${String(response.status)}: ${response.statusText}`);
  }
}

export class TimeoutError extends Error {
  override readonly name = 'TimeoutError';

  constructor(readonly timeoutMs: number) {
    super(`Request attempt timed out after ${String(timeoutMs)} ms`);
  }
}

type ReadBody<T> = (response: Response) => T | Promise<T>;

// Isolate attempt failures from p-retry's normalization and control error types.
class AttemptFailure extends Error {
  constructor(readonly original: unknown) {
    super();
  }
}

function validateMilliseconds(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new RangeError(`${name} must be an integer between 1 and 2147483647`);
  }
}

function validateRetries(value: number): void {
  if (value !== Infinity && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError('retries must be a non-negative safe integer or Infinity');
  }
}

async function attempt<T>(
  request: Request,
  init: RequestInit,
  read: ReadBody<T>,
  timeoutMs: number,
  fetcher: typeof globalThis.fetch,
): Promise<T> {
  const deadline = new AbortController();
  const signal = AbortSignal.any([request.signal, deadline.signal]);
  const timer = setTimeout(() => {
    deadline.abort(new TimeoutError(timeoutMs));
  }, timeoutMs);
  try {
    return await abortable(async () => {
      const response = await fetcher(request, {
        ...init,
        method: request.method,
        signal,
        // A nonempty RequestInit resets both referrer fields in the Fetch constructor.
        referrer: request.referrer,
        referrerPolicy: request.referrerPolicy,
      });
      signal.throwIfAborted();
      if (!response.ok) {
        throw new HTTPError(response);
      }
      return read(response);
    }, signal);
  } catch (error) {
    throw new AttemptFailure(error);
  } finally {
    clearTimeout(timer);
  }
}

/**
Create a Web Fetch client. DNS and connection selection remain with the runtime.
*/
export function createClient(options: ClientOptions = {}): Client {
  const {
    retries = Infinity,
    timeoutMs = 20_000,
    retryDelayMs = 1000,
    maxRetryDelayMs = 10_000,
  } = options;
  const baseUrl = options.baseUrl === undefined ? undefined : new URL(options.baseUrl).href;
  const headers = new Headers(options.headers);
  const credentials = options.credentials ?? 'same-origin';
  const fetcher = options.fetch ?? fetch.bind(globalThis);
  validateRetries(retries);
  validateMilliseconds('timeoutMs', timeoutMs);
  validateMilliseconds('retryDelayMs', retryDelayMs);
  validateMilliseconds('maxRetryDelayMs', maxRetryDelayMs);
  if (retryDelayMs > maxRetryDelayMs) {
    throw new RangeError('retryDelayMs must not exceed maxRetryDelayMs');
  }

  async function send<T>(
    input: string | URL,
    read: ReadBody<T>,
    requestOptions: RequestOptions = {},
  ): Promise<T> {
    const {
      retries: retryLimit = retries,
      timeoutMs: deadlineMs = timeoutMs,
      credentials: requestCredentials = credentials,
      signal,
      headers: extraHeaders,
    } = requestOptions;
    validateRetries(retryLimit);
    validateMilliseconds('timeoutMs', deadlineMs);
    // Do not acquire streaming upload resources for an already cancelled operation.
    signal?.throwIfAborted();
    const url = new URL(input, baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new TypeError('Only HTTP and HTTPS URLs are supported');
    }
    const requestHeaders = new Headers(headers);
    const additions = new Headers(extraHeaders);
    // Replace each group, then retain every value yielded for that header name.
    for (const name of additions.keys()) {
      requestHeaders.delete(name);
    }
    for (const [name, value] of additions) {
      requestHeaders.append(name, value);
    }
    const { request, init } = prepareRequest(url, requestOptions, {
      credentials: requestCredentials,
      headers: requestHeaders,
      signal,
    });
    const canRetry = ['GET', 'HEAD'].includes(request.method);
    if (canRetry && init.body !== undefined && init.body !== null) {
      throw new TypeError('GET and HEAD requests cannot have a body');
    }
    try {
      return await pRetry(() => attempt(request, init, read, deadlineMs, fetcher), {
        retries: canRetry ? retryLimit : 0,
        minTimeout: retryDelayMs,
        maxTimeout: maxRetryDelayMs,
        signal: request.signal,
        shouldRetry: ({ error }): boolean => {
          const failure = error instanceof AttemptFailure ? error.original : error;
          try {
            return failure instanceof TimeoutError || isNetworkError(failure);
          } catch {
            // Uninspectable failures must be returned unchanged, without retrying.
          }
          return false;
        },
      });
    } catch (error) {
      // p-retry normalizes thrown values; cancellation must preserve the caller's exact reason.
      request.signal.throwIfAborted();
      throw error instanceof AttemptFailure ? error.original : error;
    }
  }

  return {
    request: (input, init): Promise<Response> => send(input, (response) => response, init),
    read: send,
    json: async <T = unknown>(input: string | URL, init?: RequestOptions): Promise<T> => {
      const result: unknown = await send(input, (response) => response.json(), init);
      return result as T;
    },
    text: (input, init): Promise<string> => send(input, (response) => response.text(), init),
    blob: (input, init): Promise<Blob> => send(input, (response) => response.blob(), init),
    arrayBuffer: (input, init): Promise<ArrayBuffer> =>
      send(input, (response) => response.arrayBuffer(), init),
  };
}
