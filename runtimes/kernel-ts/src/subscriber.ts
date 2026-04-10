/**
 * Subscriber — read-only view of the kernel's outbound frame broadcast.
 *
 * Every frame that the kernel routes to a caller's pending stream is also
 * delivered to all active `Subscriber` instances. This makes subscribers the
 * primary mechanism for monitoring, tracing, and integration testing: a test
 * can attach a subscriber, drive requests through the kernel, and assert on
 * the exact sequence of frames observed.
 *
 * Subscribers are passive consumers — they cannot push frames into the kernel.
 * Their queue is managed by `SubscriberRegistry`, which enforces backpressure
 * and evicts slow consumers that exceed their stall timeout.
 *
 * Create a subscriber via `Kernel.subscribe()`.
 */

import type { Frame } from "muninn-frames-ts";

import { AsyncQueue } from "./queue.js";

/**
 * Options controlling when `Subscriber.collect()` stops accumulating frames.
 */
export interface SubscriberCollectOptions {
  /**
   * When provided, `collect()` stops after the first frame for which this
   * predicate returns `true`. Useful for waiting on a specific terminal event
   * without knowing exactly how many frames will precede it.
   */
  until?: (frame: Frame) => boolean;
  /**
   * When provided, `collect()` stops as soon as the signal is aborted,
   * returning whatever frames have accumulated so far.
   */
  signal?: AbortSignal;
}

/**
 * A broadcast consumer that receives every frame the kernel emits.
 *
 * `Subscriber` wraps an `AsyncQueue<Frame>` that the `SubscriberRegistry`
 * pushes into on each `deliver()` call. It satisfies `AsyncIterable<Frame>`
 * so it can be consumed with `for await`, and also exposes `recv()` for
 * one-at-a-time polling and `collect()` for test-oriented batch accumulation.
 *
 * TRADE-OFFS:
 * The subscriber receives all frames — including internal cancellation and
 * error frames — not just those for a specific request. Callers that care
 * about a single request should filter by `parent_id` or use `Caller` and
 * its `CallStream` instead.
 */
export class Subscriber implements AsyncIterable<Frame> {
  constructor(private readonly queue: AsyncQueue<Frame>) {}

  next(): Promise<IteratorResult<Frame>> {
    return this.queue.next();
  }

  recv(): Promise<Frame | undefined> {
    return this.queue.recv();
  }

  /**
   * Accumulates frames into an array until the `until` predicate matches,
   * the `signal` is aborted, or the underlying queue is closed.
   *
   * Designed for test scenarios where you want to assert on the complete
   * sequence of frames produced by a kernel interaction.
   *
   * @param options - Optional termination predicate and/or abort signal.
   * @returns All frames received before the stopping condition was met.
   */
  async collect(options: SubscriberCollectOptions = {}): Promise<Frame[]> {
    const frames: Frame[] = [];

    for await (const frame of abortable(this, options.signal)) {
      frames.push(frame);
      if (options.until?.(frame) ?? false) {
        break;
      }
    }

    return frames;
  }

  [Symbol.asyncIterator](): AsyncIterator<Frame> {
    return {
      next: () => this.next()
    };
  }
}

/**
 * Wraps an `AsyncIterable<Frame>` to stop iteration early when `signal` is
 * aborted. Checked before yielding each frame so the caller is not blocked
 * waiting for the next item after the signal fires.
 *
 * Exists as a separate generator rather than inline logic in `collect()` so
 * the abort check composes cleanly with the `for await` loop.
 */
async function* abortable(
  iterable: AsyncIterable<Frame>,
  signal?: AbortSignal
): AsyncIterable<Frame> {
  if (signal?.aborted) {
    return;
  }

  for await (const frame of iterable) {
    if (signal?.aborted) {
      return;
    }

    yield frame;
  }
}
