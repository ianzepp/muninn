/**
 * Unbounded, closeable async queue used throughout the kernel for frame transport.
 *
 * `AsyncQueue<T>` is the single concurrency primitive in this library. Every
 * in-flight message channel — pending caller streams, pipe endpoints, sigcall
 * endpoints, and subscriber queues — is backed by one instance.
 *
 * The queue satisfies the `AsyncIterable<T>` protocol so callers can consume
 * it with `for await`. It also exposes `recv()` for one-at-a-time polling and
 * `waitForBelow()` for the subscriber backpressure mechanism.
 *
 * TRADE-OFFS:
 * The queue is deliberately unbounded on the push side to keep the kernel's
 * routing paths synchronous. Backpressure is enforced externally by
 * `SubscriberRegistry.deliverToSubscriber`, which stalls before pushing to a
 * queue whose depth exceeds the high-watermark threshold.
 */

/**
 * A pull-based async FIFO queue that resolves waiting consumers immediately
 * when an item arrives, or buffers items when no consumer is waiting.
 *
 * Closing the queue signals all pending `next()` calls with `done: true` and
 * causes subsequent `push()` calls to be silently dropped.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly resolvers: Array<(result: IteratorResult<T>) => void> = [];
  private readonly drainWaiters: Array<() => void> = [];
  private closed = false;

  get size(): number {
    return this.items.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Enqueues a value, or resolves a waiting consumer immediately if one exists.
   * Silently no-ops if the queue is already closed.
   */
  push(value: T): void {
    if (this.closed) {
      return;
    }

    const resolve = this.resolvers.shift();
    if (resolve !== undefined) {
      resolve({ value, done: false });
      return;
    }

    this.items.push(value);
  }

  /**
   * Closes the queue, unblocking all pending `next()` calls with `done: true`
   * and notifying any drain waiters. Idempotent — subsequent calls are no-ops.
   */
  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;

    while (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift();
      resolve?.({ value: undefined, done: true });
    }

    this.notifyDrained();
  }

  /**
   * Returns the next item, consuming it from the buffer, or waits until one
   * arrives. Returns `{ done: true }` when the queue is closed and empty.
   */
  async next(): Promise<IteratorResult<T>> {
    const value = this.items.shift();
    if (value !== undefined) {
      this.notifyDrained();
      return { value, done: false };
    }

    if (this.closed) {
      return { value: undefined, done: true };
    }

    return new Promise<IteratorResult<T>>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  /**
   * Convenience wrapper around `next()` that returns `undefined` when the
   * queue is closed, matching the common pattern of optional-typed polling.
   */
  async recv(): Promise<T | undefined> {
    const result = await this.next();
    return result.done ? undefined : result.value;
  }

  /**
   * Waits until the queue depth drops to or below `limit`, then resolves
   * `true`. Resolves `false` if `timeoutMs` elapses first.
   *
   * This is the hook used by subscriber backpressure: the delivery path calls
   * this before pushing to a queue that has exceeded its high-watermark, then
   * evicts the subscriber if the queue fails to drain in time.
   *
   * @param limit - Target queue depth to wait for.
   * @param timeoutMs - Maximum wait time in milliseconds.
   * @returns `true` if the queue drained within the timeout, `false` otherwise.
   */
  async waitForBelow(limit: number, timeoutMs: number): Promise<boolean> {
    if (this.size <= limit || this.closed) {
      return true;
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const index = this.drainWaiters.indexOf(check);
        if (index >= 0) {
          this.drainWaiters.splice(index, 1);
        }
        resolve(false);
      }, timeoutMs);

      const check = () => {
        if (this.size <= limit || this.closed) {
          clearTimeout(timer);
          const index = this.drainWaiters.indexOf(check);
          if (index >= 0) {
            this.drainWaiters.splice(index, 1);
          }
          resolve(true);
        }
      };

      this.drainWaiters.push(check);
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next()
    };
  }

  private notifyDrained(): void {
    for (const waiter of [...this.drainWaiters]) {
      waiter();
    }
  }
}
