import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { abortable } from '../../packages/reboop/src/abortable.js';

describe('cancellation listener lifecycle', () => {
  it('releases the listener after success without aborting the caller', async () => {
    const controller = new AbortController();
    const pending = abortable(() => Promise.resolve(42), controller.signal);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    await expect(pending).resolves.toBe(42);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(controller.signal.aborted).toBe(false);
  });

  it('releases the listener when the operation rejects', async () => {
    const controller = new AbortController();
    const error = new Error('failure');
    await expect(abortable(() => Promise.reject(error), controller.signal)).rejects.toBe(error);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('releases the listener after cancellation even if the operation is still pending', async () => {
    const controller = new AbortController();
    const operation = Promise.withResolvers<number>();
    const pending = abortable(() => operation.promise, controller.signal);
    const rejected = expect(pending).rejects.toBe('cancel');
    controller.abort('cancel');
    await rejected;
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    operation.resolve(42);
  });
});
