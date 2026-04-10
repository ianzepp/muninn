/**
 * Core shared types and constants for the muninn-kernel-ts microkernel.
 *
 * This module defines the two fundamental extension points of the kernel:
 * - `Syscall`: the interface that statically-registered handlers must implement
 * - `BackpressureConfig`: flow-control thresholds applied to subscriber queues
 *
 * Syscall handlers are registered at kernel construction time (or before the
 * first dispatch) via `Kernel.register()`. Dynamic, runtime handlers are
 * managed separately by `SigcallRegistry`.
 *
 * TRADE-OFFS:
 * The `Syscall.dispatch` contract uses an `AsyncIterable<Frame>` rather than a
 * callback so handlers can yield multiple response frames (item*, bulk*, then a
 * terminal) without needing an explicit reply channel. The kernel owns protocol
 * enforcement — handlers that forget a terminal frame receive a synthetic error.
 */

import type { Frame } from "muninn-frames-ts";

import type { Caller } from "./caller.js";

/**
 * Handler interface for statically-registered kernel prefixes.
 *
 * Implement this interface to handle all frames whose `call` prefix matches
 * the value returned by `prefix()`. Register instances with `Kernel.register()`.
 *
 * The `dispatch` method must yield at least one terminal frame (done, error, or
 * cancel) before returning; if it does not, the kernel synthesises an error
 * response to protect the caller's stream from hanging.
 */
export interface Syscall {
  /** The routing key — frames whose call prefix equals this value are dispatched here. */
  prefix(): string;

  /**
   * Handle an inbound request frame and yield response frames.
   *
   * @param frame - The inbound request frame to handle.
   * @param caller - A kernel-bound caller the handler can use to issue sub-requests.
   * @param cancel - Aborted when the originating caller sends a `cancel` frame.
   *   Handlers should respect this to avoid doing unnecessary work.
   * @returns An async iterable of response frames. Must include a terminal frame
   *   (status `done`, `error`, or `cancel`) as the final yield.
   */
  dispatch(
    frame: Frame,
    caller: Caller,
    cancel: AbortSignal
  ): AsyncIterable<Frame>;
}

/**
 * Flow-control thresholds for a single subscriber queue.
 *
 * The kernel applies these limits per `Subscriber` to prevent a slow consumer
 * from indefinitely buffering frames. When the queue depth reaches
 * `highWatermark`, the delivery path stalls until the queue drains below
 * `lowWatermark` or `stallTimeoutMs` elapses. On timeout the subscriber is
 * evicted and its queue is closed.
 */
export interface BackpressureConfig {
  /** Queue depth at which the kernel begins stalling frame delivery. */
  highWatermark: number;
  /** Queue depth the kernel waits for before resuming delivery after a stall. */
  lowWatermark: number;
  /** Maximum milliseconds to wait for the queue to drain before evicting the subscriber. */
  stallTimeoutMs: number;
}

/**
 * Production-ready backpressure defaults.
 *
 * The hysteresis gap between high (1000) and low (100) watermarks is
 * intentionally wide to avoid rapid stall/resume oscillation under bursty
 * traffic. The 5-second stall timeout is generous enough for typical I/O
 * consumers while still preventing unbounded memory growth.
 */
export const DEFAULT_BACKPRESSURE: BackpressureConfig = {
  highWatermark: 1000,
  lowWatermark: 100,
  stallTimeoutMs: 5000
};
