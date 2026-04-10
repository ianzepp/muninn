/**
 * PipeEnd — the external interface for a kernel-registered pipe prefix.
 *
 * When a prefix is registered with `Kernel.registerPrefix()`, the kernel
 * creates an `AsyncQueue<Frame>` for inbound requests and returns a `PipeEnd`
 * bound to that queue. The owning component (e.g. an external process bridge
 * or a worker-thread adapter) uses the `PipeEnd` to:
 * - read inbound requests via `recv()`
 * - write response frames back into the kernel via `send()`
 * - issue secondary requests via a kernel-bound `Caller`
 *
 * This is the primary integration point for non-`Syscall` handlers — any code
 * that cannot implement the synchronous `AsyncIterable<Frame>` generator
 * pattern (e.g. because it bridges to an external I/O system) should use a
 * pipe prefix instead.
 *
 * TRADE-OFFS:
 * Pipes give the handler full control over the response lifecycle at the cost
 * of requiring manual protocol adherence: the handler must eventually send a
 * terminal frame, otherwise the caller's stream hangs. `Syscall` handlers get
 * automatic terminal enforcement from `Kernel.runSyscall()`.
 */

import type { Frame } from "muninn-frames-ts";

import { AsyncQueue } from "./queue.js";
import { Caller } from "./caller.js";
import type { Kernel } from "./kernel.js";

/**
 * External handle for a kernel-registered pipe prefix.
 *
 * Acquired via `Kernel.registerPrefix(prefix)`. The kernel routes all frames
 * whose call prefix matches the registered value into the internal queue;
 * the owner of this `PipeEnd` drains that queue with `recv()` and responds
 * by calling `send()`.
 */
export class PipeEnd {
  constructor(
    private readonly kernel: Kernel,
    private readonly inbound: AsyncQueue<Frame>
  ) {}

  /**
   * Dispatches a response (or any frame) back into the kernel.
   *
   * The frame flows through `Kernel.dispatch()`, which routes it to the
   * appropriate pending caller stream and delivers it to all subscribers.
   * The handler is responsible for ensuring at least one terminal frame
   * is eventually sent for each inbound request.
   *
   * @param frame - The frame to dispatch into the kernel.
   */
  async send(frame: Frame): Promise<void> {
    await this.kernel.dispatch(frame);
  }

  /**
   * Reads the next inbound request frame from the pipe's queue.
   *
   * Returns `undefined` when the pipe's queue has been closed (typically
   * when the kernel is shutting down or the prefix is being deregistered).
   */
  recv(): Promise<Frame | undefined> {
    return this.inbound.recv();
  }

  /**
   * Returns a new `Caller` bound to this pipe's kernel instance, allowing
   * the pipe handler to issue sub-requests as part of processing an inbound
   * frame.
   */
  caller(): Caller {
    return this.kernel.caller();
  }
}
