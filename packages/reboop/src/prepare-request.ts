/**
Let native Request read its supported dictionary fields, including inherited getters.
Snapshot those values, while leaving upload acquisition to the actual fetch attempt.
*/
export function prepareRequest(
  url: URL,
  options: RequestInit,
  overrides: {
    headers: Headers;
    credentials: Request['credentials'];
    signal: RequestInit['signal'];
  },
): { request: Request; init: RequestInit } {
  const init: RequestInit = { headers: overrides.headers, credentials: overrides.credentials };
  Object.defineProperties(init, {
    signal: { value: overrides.signal },
    body: {
      configurable: true,
      enumerable: true,
      get: (): RequestInit['body'] => {
        const body = options.body;
        Object.defineProperty(init, 'body', { value: body });
        return body;
      },
    },
  });
  const metadata = new Proxy(
    {},
    {
      get(_target, key): unknown {
        if (key === 'body') {
          return undefined;
        }
        if (!Object.hasOwn(init, key)) {
          const value: unknown = Reflect.get(options, key, options);
          Object.defineProperty(init, key, { value, enumerable: true });
        }
        return Reflect.get(init, key);
      },
    },
  );
  return { request: new Request(url, metadata), init };
}
