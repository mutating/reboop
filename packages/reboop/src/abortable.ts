/**
Enforce cancellation even when an injected fetch/body reader ignores its signal.
*/
export async function abortable<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const cleanup = new AbortController();
  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        const reason: unknown = signal.reason;
        reject(reason);
      },
      { signal: cleanup.signal },
    );
  });
  try {
    return await Promise.race([run(), aborted]);
  } finally {
    cleanup.abort();
  }
}
