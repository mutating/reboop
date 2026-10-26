# reboop

Fetch-based HTTP client for browsers and Node.js. GET and HEAD recover from network failures
with bounded exponential backoff, a deadline for each attempt, and caller cancellation.

```sh
npm install reboop
```

```ts
import { createClient } from 'reboop';

const api = createClient({
  baseUrl: 'https://api.example.com/v1/',
  credentials: 'include',
  headers: { 'X-Requested-With': 'MyApp' },
});

const controller = new AbortController();
const items = await api.json<{ id: string }[]>('items', {
  signal: controller.signal,
});
// Abort when the view is disposed: controller.abort().

// Writes are sent once, even when their response is lost.
await api.json('items', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: 'New item' }),
});
```

## Retry policy

| Failure                                                    | GET / HEAD          | Other methods |
| ---------------------------------------------------------- | ------------------- | ------------- |
| Fetch network error, including interruption of a body read | Retry               | Reject        |
| Attempt deadline exceeded                                  | Retry               | Reject        |
| HTTP error (including 408, 429 and 5xx)                    | Reject: HTTPError   | Reject        |
| Invalid JSON or other non-network error                    | Reject              | Reject        |
| Caller cancellation                                        | Reject immediately  | Reject        |
| Invalid URL, method, headers or body                       | Reject before fetch | Reject        |

GET and HEAD retry **indefinitely by default**. Use a caller signal or a finite `retries`
limit when an operation must eventually stop. `retries` counts additional attempts: `0`
means one attempt, `2` means at most three. Even an explicit `retries` value cannot enable
automatic retries for other methods. A network failure cannot prove whether a write was
already applied by the server.

Backoff is 1, 2, 4, 8, then 10 seconds between attempts by default, without jitter. It is
independent for each request. A new attempt gets a fresh timeout and abort signal. The original
hostname is preserved; reboop does not resolve DNS or embed server addresses. Browser DNS,
connection pooling and address selection still apply, so a retry **cannot guarantee switching
to another IP**. CORS failures and some permanent network failures are indistinguishable from
temporary Fetch network errors and can also keep retrying.

Retry scheduling uses [p-retry](https://github.com/sindresorhus/p-retry), with network error
recognition from [is-network-error](https://github.com/sindresorhus/is-network-error).
Unknown errors are not treated as retryable transport failures.

## Client configuration

```ts
const api = createClient({
  baseUrl: 'https://api.example.com/v1/',
  timeoutMs: 20_000,
  retries: Infinity,
  retryDelayMs: 1000,
  maxRetryDelayMs: 10_000,
  headers: { Accept: 'application/json' },
  credentials: 'same-origin',
  // fetch: customFetch,
});
```

All settings are optional. The values above show defaults, except `baseUrl` and `headers`,
which are absent by default. Client defaults are snapshotted at creation. Each call accepts
`RequestInit` plus `timeoutMs` and `retries` overrides. Headers merge case-insensitively;
request headers override client headers. Reboop does not set Content-Type, serialize request
bodies, add authentication, or interpret application-specific response headers.

URLs use `new URL(input, baseUrl)` semantics. Relative inputs require an absolute `baseUrl`;
without one, pass an absolute URL, including in browsers. A trailing `/` in the base matters:
`items` extends `/v1/`, whereas `/items` starts at the origin. Absolute inputs override the
base, including its origin, so use trusted inputs when client defaults contain credentials
or sensitive headers. Only HTTP and HTTPS are supported. Inputs are strings or URL objects;
Request instances are deliberately excluded to avoid replaying consumed request streams.

Durations must be integers from 1 to 2,147,483,647 milliseconds, and `retryDelayMs` must not
exceed `maxRetryDelayMs`. `retries` must be a non-negative safe integer or `Infinity`.
Invalid settings fail immediately with RangeError.

## Response methods and deadlines

| Method                            | Resolves to   | Deadline / retry scope           |
| --------------------------------- | ------------- | -------------------------------- |
| `api.json<T>(input, options)`     | `T`           | Headers and complete JSON body   |
| `api.text(input, options)`        | `string`      | Headers and complete text body   |
| `api.blob(input, options)`        | `Blob`        | Headers and complete binary body |
| `api.arrayBuffer(input, options)` | `ArrayBuffer` | Headers and complete binary body |
| `api.request(input, options)`     | `Response`    | **Headers only**                 |

Body-reading methods keep the attempt deadline active until their body has been consumed.
If a GET/HEAD body is interrupted, the whole request starts again. They buffer the full body
in memory; use `request` for streaming and implement any stream recovery at the application
level. After `request` resolves, consuming its response body is outside reboop's retry and
timeout handling. Consume or cancel raw response bodies to release their resources.

JSON uses native Response.json semantics: malformed or empty JSON rejects with SyntaxError,
including an empty 204/HEAD response. Use `request` or `text` for responses with no JSON body.
The generic `T` is a TypeScript assertion, not runtime validation; the default result type
is `unknown`. Apply a schema validator separately when needed.

The attempt timeout defaults to 20 seconds, not a total operation deadline. To bound the
entire operation, including backoff, pass `signal: AbortSignal.timeout(60_000)`. Cancellation
works before a request, during fetch/body consumption, and during backoff; it preserves the
caller's exact abort reason and never retries it. Internal timers and cancellation listeners
are cleaned up on completion. As with other JavaScript timers, background throttling or a
blocked event loop can postpone deadlines. An injected `fetch` should honor Request.signal
to stop its underlying I/O; reboop will reject on time even if that implementation ignores it.

## Errors

```ts
import { HTTPError, TimeoutError } from 'reboop';

try {
  await api.json('items', { retries: 2 });
} catch (error) {
  if (error instanceof HTTPError) {
    console.error(error.response.status, await error.response.text());
  } else if (error instanceof TimeoutError) {
    console.error(`Attempt exceeded ${error.timeoutMs} ms`);
  } else {
    throw error; // Last network error, decode failure, or caller abort reason.
  }
}
```

Non-2xx responses reject with `HTTPError`, exposing the original, unconsumed `response`.
Its body is outside the retry deadline, just like a raw response. `TimeoutError.timeoutMs`
contains the attempt deadline. When finite retries are exhausted, the last failure is
returned without wrapping. Native redirect behavior is preserved; `redirect: 'manual'` can
produce an opaque/non-2xx response, which is also an HTTPError.

## Runtime and development

ES modules with TypeScript declarations; no Node-only runtime imports. Requires native Web
Fetch APIs including Request, Response, Headers, Blob, AbortController and AbortSignal.any.
Supported Node versions start at 22.14.0; browsers need these APIs or application-provided
polyfills. A bundler/import map must resolve the npm dependencies for browser usage.

See the [repository](https://github.com/mutating/reboop) for checks and release instructions.
