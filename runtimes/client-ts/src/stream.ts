/**
 * ClientStream — async iterable response stream for a single outbound request.
 *
 * Mirrors the kernel's CallStream semantics: frames arrive until a terminal
 * status (done, error, cancel) closes the stream. Provides the same
 * `collect()` and `recv()` conveniences.
 */

import type { Frame } from "muninn-frames-ts";
import { isTerminalStatus } from "muninn-frames-ts";

/**
 * Internal FIFO queue that backs a ClientStream.
 *
 * Pull-based: `next()` resolves immediately if data is buffered, otherwise
 * parks until `push()` or `close()` is called.
 */
class Queue<T> {
  private readonly buffer: T[] = [];
  private resolve: ((value: IteratorResult<T>) => void) | undefined;
  private done = false;

  push(value: T): void {
    if (this.done) return;
    if (this.resolve !== undefined) {
      const r = this.resolve;
      this.resolve = undefined;
      r({ value, done: false });
    } else {
      this.buffer.push(value);
    }
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    if (this.resolve !== undefined) {
      const r = this.resolve;
      this.resolve = undefined;
      r({ value: undefined as unknown as T, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.buffer.length > 0) {
      return Promise.resolve({ value: this.buffer.shift()!, done: false });
    }
    if (this.done) {
      return Promise.resolve({ value: undefined as unknown as T, done: true });
    }
    return new Promise<IteratorResult<T>>((resolve) => {
      this.resolve = resolve;
    });
  }
}

/**
 * Async iterable stream of response frames for a dispatched request.
 *
 * The client pushes decoded response frames onto the stream's internal queue
 * as they arrive from the transport. The stream closes automatically when a
 * terminal frame arrives, or can be closed early by the caller.
 */
export class ClientStream implements AsyncIterable<Frame> {
  private readonly queue = new Queue<Frame>();
  private closed = false;

  constructor(
    /** The original request frame that created this stream. */
    readonly request: Frame
  ) {}

  /**
   * Called by the client to deliver a response frame.
   * Automatically closes the stream on terminal status.
   * @internal
   */
  _push(frame: Frame): void {
    if (this.closed) return;
    this.queue.push(frame);
    if (isTerminalStatus(frame.status)) {
      this.closed = true;
      this.queue.close();
    }
  }

  /**
   * Called by the client when the transport closes unexpectedly.
   * @internal
   */
  _close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.close();
  }

  next(): Promise<IteratorResult<Frame>> {
    return this.queue.next();
  }

  async recv(): Promise<Frame | undefined> {
    const result = await this.next();
    return result.done ? undefined : result.value;
  }

  /**
   * Collects all response frames up to and including the first terminal frame.
   */
  async collect(): Promise<Frame[]> {
    const frames: Frame[] = [];
    for await (const frame of this) {
      frames.push(frame);
      if (isTerminalStatus(frame.status)) {
        break;
      }
    }
    return frames;
  }

  /**
   * Closes the stream early. Subsequent `next()` calls return done.
   */
  close(): void {
    this._close();
  }

  [Symbol.asyncIterator](): AsyncIterator<Frame> {
    return { next: () => this.next() };
  }
}
