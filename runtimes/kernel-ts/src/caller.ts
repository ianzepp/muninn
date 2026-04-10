/**
 * Caller and CallStream — the outbound request API for the kernel.
 *
 * `Caller` is the surface through which code issues requests into the kernel.
 * Each call dispatches a request frame and registers a pending entry so the
 * kernel can route response frames back. Responses arrive as an async stream
 * (`CallStream`) that terminates when a terminal frame (done, error, cancel)
 * is received or when the stream is explicitly closed.
 *
 * `CallStream` additionally supports cooperative cancellation via `AbortSignal`:
 * when the signal fires, a `cancel` frame is dispatched into the kernel,
 * which triggers the active handler's own abort path.
 *
 * Obtain a `Caller` via `Kernel.caller()` or `PipeEnd.caller()`.
 */

import type { Frame } from "muninn-frames-ts";
import { isTerminalStatus } from "muninn-frames-ts";

import { AsyncQueue } from "./queue.js";
import { responseFrom } from "./frame.js";
import type { Kernel } from "./kernel.js";

/**
 * Options for a single outbound call.
 */
export interface CallOptions {
  /**
   * When provided, aborting this signal dispatches a `cancel` frame for the
   * in-flight request, signalling the handler to stop processing. The
   * `CallStream` remains open until the kernel confirms cancellation with a
   * terminal frame.
   */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// CallStream — async response stream for a single outbound request
// ---------------------------------------------------------------------------

/**
 * Async iterable stream of response frames for a dispatched request.
 *
 * The kernel pushes response frames (item, bulk, done, error, cancel) onto the
 * stream's internal queue as the handler emits them. The stream closes
 * automatically when a terminal frame arrives, or can be closed early by the
 * caller via `close()`.
 *
 * Cleanup callbacks registered with `onClose()` are guaranteed to fire exactly
 * once — either when the stream closes naturally or when `close()` is called
 * explicitly. This is used internally to remove `AbortSignal` listeners and
 * to deregister the pending entry from the kernel.
 */
export class CallStream implements AsyncIterable<Frame> {
  private closed = false;
  private readonly cleanupCallbacks = new Set<() => void>();

  constructor(
    /** The original request frame that created this stream. */
    readonly request: Frame,
    private readonly queue: AsyncQueue<Frame>,
    private readonly closeHandler: () => void
  ) {}

  next(): Promise<IteratorResult<Frame>> {
    return this.queue.next();
  }

  recv(): Promise<Frame | undefined> {
    return this.queue.recv();
  }

  /**
   * Collects all response frames up to and including the first terminal frame.
   *
   * Suitable for request-response interactions where the caller wants to wait
   * for the full result before continuing. For streaming results, use `for await`
   * directly on the `CallStream`.
   *
   * @returns All frames received, ending with the terminal frame.
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
   * Registers a callback to run when this stream closes.
   *
   * If the stream is already closed the callback is invoked immediately.
   * Multiple callbacks can be registered; all are called in registration order.
   * Used internally for `AbortSignal` listener cleanup.
   *
   * @param callback - Function to call on stream close.
   */
  onClose(callback: () => void): void {
    if (this.closed) {
      callback();
      return;
    }

    this.cleanupCallbacks.add(callback);
  }

  /**
   * Closes the stream, drains the queue, and runs all cleanup callbacks.
   *
   * Idempotent — subsequent calls are no-ops. After closing, `next()` and
   * `recv()` will return `done: true` / `undefined` immediately.
   */
  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.queue.close();
    this.closeHandler();

    for (const callback of this.cleanupCallbacks) {
      callback();
    }
    this.cleanupCallbacks.clear();
  }

  [Symbol.asyncIterator](): AsyncIterator<Frame> {
    return {
      next: () => this.next()
    };
  }
}

// ---------------------------------------------------------------------------
// Caller — issues outbound requests and returns CallStreams
// ---------------------------------------------------------------------------

/**
 * Issues request frames into the kernel and returns a `CallStream` for the
 * response sequence.
 *
 * `Caller` is stateless — it holds only a reference to the kernel and creates
 * a fresh `CallStream` (with its own queue and pending registration) for every
 * `call()` invocation. This means a single `Caller` instance can safely be
 * used concurrently for multiple in-flight requests.
 */
export class Caller {
  constructor(private readonly kernel: Kernel) {}

  /**
   * Dispatches `frame` as a request and returns a `CallStream` that delivers
   * the handler's response frames as they arrive.
   *
   * The frame is registered as pending before dispatch so the kernel can
   * immediately route any synchronously-emitted responses back. If `options.signal`
   * is already aborted, a cancel frame is dispatched right away.
   *
   * @param frame - The request frame to dispatch. Must have status `"request"`.
   * @param options - Optional abort signal for cooperative cancellation.
   * @returns A `CallStream` that yields response frames for this request.
   */
  call(frame: Frame, options: CallOptions = {}): CallStream {
    const queue = new AsyncQueue<Frame>();
    const stream = new CallStream(frame, queue, () => {
      this.kernel.unregisterPending(frame.id);
    });

    this.kernel.registerPending(frame.id, queue, stream);
    void this.kernel.dispatch(frame);

    if (options.signal !== undefined) {
      const onAbort = () => {
        void this.kernel.dispatch(responseFrom(frame, "cancel", {}));
      };

      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
        stream.onClose(() => {
          options.signal?.removeEventListener("abort", onAbort);
        });
      }
    }

    return stream;
  }

  /**
   * Convenience wrapper that calls `call()` and collects all response frames
   * up to and including the terminal frame.
   *
   * @param frame - The request frame to dispatch.
   * @param options - Optional abort signal.
   * @returns All response frames for the request, ending with the terminal frame.
   */
  async collect(frame: Frame, options: CallOptions = {}): Promise<Frame[]> {
    return this.call(frame, options).collect();
  }

  /**
   * Convenience wrapper that dispatches a request, reads the first response
   * frame, then immediately closes the stream.
   *
   * Useful for fire-and-check interactions where only the leading frame (or
   * a quick done/error) is needed and the caller does not want to consume the
   * full stream.
   *
   * @param frame - The request frame to dispatch.
   * @param options - Optional abort signal.
   * @returns The first response frame, or `undefined` if the stream closes without one.
   */
  async first(frame: Frame, options: CallOptions = {}): Promise<Frame | undefined> {
    const stream = this.call(frame, options);
    const first = await stream.recv();
    stream.close();
    return first;
  }
}
