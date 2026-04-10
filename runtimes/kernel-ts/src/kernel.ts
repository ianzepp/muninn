/**
 * Kernel — the central frame router of the muninn-kernel-ts microkernel.
 *
 * The `Kernel` accepts inbound frames via `dispatch()` and routes them to the
 * correct handler based on the frame's call prefix and status:
 *
 * - status `"request"`: routed to a syscall, pipe, or sigcall handler (in that
 *   priority order), or rejected with an `E_NO_ROUTE` error if nothing matches.
 * - status `"cancel"`: propagates abort to the active handler and emits a
 *   terminal cancel frame back to the caller's pending stream.
 * - any other status (item, bulk, done, error): treated as a response and
 *   delivered to the pending caller stream identified by `parent_id`, then
 *   broadcast to all subscribers.
 *
 * Handler registration:
 * - `register(syscall)` — static, prefix-keyed handler implementing `Syscall`
 * - `registerPrefix(prefix)` — pipe-based handler; returns a `PipeEnd`
 * - `sigcalls()` — access the dynamic `SigcallRegistry` for runtime registration
 *
 * The `sigcall:` prefix namespace is reserved for introspection of the sigcall
 * registry itself (`sigcall:list`). Other `sigcall:*` verbs are rejected.
 *
 * TRADE-OFFS:
 * Syscall handlers that forget to yield a terminal frame receive a synthetic
 * `E_INTERNAL` error, protecting callers from stream stalls. Pipe and sigcall
 * handlers do not get this protection — they own the protocol themselves.
 */

import type { Frame } from "muninn-frames-ts";
import { isTerminalStatus, validateFrame } from "muninn-frames-ts";

import { CallStream, Caller } from "./caller.js";
import { KernelError, toKernelError } from "./errors.js";
import { prefixOf, responseFrom, verbOf } from "./frame.js";
import { normalizeResponse } from "./normalize.js";
import { PipeEnd } from "./pipe.js";
import { AsyncQueue } from "./queue.js";
import { SigcallRegistry } from "./sigcall.js";
import { Subscriber } from "./subscriber.js";
import { SubscriberRegistry } from "./subscriptions.js";
import type { BackpressureConfig, Syscall } from "./types.js";
import { DEFAULT_BACKPRESSURE } from "./types.js";

/** Tracks an active caller waiting for responses to a specific request id. */
interface PendingEntry {
  queue: AsyncQueue<Frame>;
  stream: CallStream;
}

/** Tracks an in-flight request that a handler is currently processing. */
interface ActiveRequest {
  request: Frame;
  cancel: AbortController;
  route: "syscall" | "pipe" | "sigcall";
  /** The inbound queue for pipe/sigcall routes — receives the cancel frame. */
  pipe?: AsyncQueue<Frame>;
}

/**
 * In-process frame router. The single point through which all frames flow.
 *
 * Instantiate with `Kernel.create()` (or `new Kernel()`) and configure
 * handlers before issuing the first request. The kernel is not thread-safe —
 * use it within a single event-loop context.
 */
export class Kernel {
  private readonly syscalls = new Map<string, Syscall>();
  private readonly pipes = new Map<string, AsyncQueue<Frame>>();
  private readonly pending = new Map<string, PendingEntry>();
  private readonly active = new Map<string, ActiveRequest>();
  private readonly backpressure: BackpressureConfig;
  private readonly sigcallRegistry: SigcallRegistry;
  private readonly subscribers = new SubscriberRegistry();

  /** Factory that accepts partial backpressure overrides alongside `new Kernel()`. */
  static create(config: { backpressure?: Partial<BackpressureConfig> } = {}): Kernel {
    return new Kernel(config);
  }

  constructor(config: { backpressure?: Partial<BackpressureConfig> } = {}) {
    this.backpressure = {
      ...DEFAULT_BACKPRESSURE,
      ...config.backpressure
    };
    this.sigcallRegistry = new SigcallRegistry(this);
  }

  /**
   * Registers a static syscall handler. All frames whose call prefix matches
   * `syscall.prefix()` will be dispatched to `syscall.dispatch()`.
   *
   * Must be called before the first `dispatch()` for the prefix; a later
   * registration silently replaces the previous one.
   *
   * @param syscall - A handler implementing the `Syscall` interface.
   */
  register(syscall: Syscall): void {
    this.syscalls.set(syscall.prefix(), syscall);
  }

  /**
   * Registers a pipe-based handler prefix and returns the `PipeEnd` through
   * which the handler reads inbound frames and sends responses.
   *
   * Use this for handlers that cannot implement the `AsyncIterable<Frame>`
   * generator contract — for example, bridging to an external I/O system.
   *
   * @param prefix - The call prefix to claim (e.g. `"fs"`).
   * @returns A `PipeEnd` for reading inbound frames and dispatching responses.
   */
  registerPrefix(prefix: string): PipeEnd {
    const queue = new AsyncQueue<Frame>();
    this.pipes.set(prefix, queue);
    return new PipeEnd(this, queue);
  }

  /**
   * Returns a new `Caller` bound to this kernel, ready to issue outbound
   * requests and receive response streams.
   */
  caller(): Caller {
    return new Caller(this);
  }

  /**
   * Returns the `SigcallRegistry` for runtime dynamic handler registration.
   * Use this to register, unregister, or query sigcall handlers.
   */
  sigcalls(): SigcallRegistry {
    return this.sigcallRegistry;
  }

  /**
   * Creates and registers a new `Subscriber` that receives every frame
   * emitted by the kernel. Backpressure is controlled by the kernel's
   * configured `BackpressureConfig`.
   *
   * @returns A `Subscriber` instance for consuming the broadcast stream.
   */
  subscribe(): Subscriber {
    return this.subscribers.subscribe(this.backpressure);
  }

  /**
   * Registers a pending caller entry so the kernel can route response frames
   * back to the correct stream. Called internally by `Caller.call()` before
   * dispatching the request.
   *
   * @param requestId - The `id` of the in-flight request frame.
   * @param queue - The queue backing the caller's `CallStream`.
   * @param stream - The `CallStream` to close when a terminal frame arrives.
   */
  registerPending(requestId: string, queue: AsyncQueue<Frame>, stream: CallStream): void {
    this.pending.set(requestId, { queue, stream });
  }

  /**
   * Removes a pending caller entry and closes its queue. Called when the
   * `CallStream` is closed early (before a terminal frame arrives).
   *
   * @param requestId - The `id` of the request frame to deregister.
   */
  unregisterPending(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (entry === undefined) {
      return;
    }

    this.pending.delete(requestId);
    entry.queue.close();
  }

  /**
   * The kernel's primary entry point — routes a frame based on its status.
   *
   * - `"request"` → `routeRequest()`
   * - `"cancel"` → `routeCancel()`
   * - anything else → `emitResponse()`
   *
   * Validates the frame against the schema before routing.
   *
   * @param frame - The frame to route.
   * @throws `FrameValidationError` if the frame fails schema validation.
   */
  async dispatch(frame: Frame): Promise<void> {
    validateFrame(frame);

    switch (frame.status) {
      case "request":
        await this.routeRequest(frame);
        break;
      case "cancel":
        await this.routeCancel(frame);
        break;
      default:
        await this.emitResponse(frame);
        break;
    }
  }

  /**
   * Routes an inbound request frame to the first matching handler.
   *
   * Priority: sigcall management → syscall → pipe → sigcall → no-route error.
   * Storing the active request before delegating ensures `routeCancel` can
   * locate and abort the in-flight handler.
   */
  private async routeRequest(frame: Frame): Promise<void> {
    const prefix = prefixOf(frame.call);
    if (prefix === "sigcall") {
      await this.handleSigcallManagement(frame);
      return;
    }

    const syscall = this.syscalls.get(prefix);
    if (syscall !== undefined) {
      const cancel = new AbortController();
      this.active.set(frame.id, { request: frame, cancel, route: "syscall" });
      const caller = this.caller();
      void this.runSyscall(syscall, frame, caller, cancel);
      return;
    }

    const pipe = this.pipes.get(prefix);
    if (pipe !== undefined) {
      this.active.set(frame.id, { request: frame, cancel: new AbortController(), route: "pipe", pipe });
      pipe.push(frame);
      return;
    }

    const sigcall = this.sigcallRegistry.lookup(frame.call);
    if (sigcall !== undefined) {
      this.active.set(frame.id, {
        request: frame,
        cancel: new AbortController(),
        route: "sigcall",
        pipe: sigcall
      });
      sigcall.push(frame);
      return;
    }

    await this.emitResponse(responseFrom(frame, "error", KernelError.noRoute(`no route for prefix: ${prefix}`).toData()));
  }

  /**
   * Drives a syscall handler to completion, normalising each yielded frame
   * and enforcing the terminal-frame requirement.
   *
   * If the handler exits without yielding a terminal frame (and was not
   * cancelled), the kernel synthesises an `E_INTERNAL` error to prevent the
   * caller's stream from hanging indefinitely.
   *
   * Errors thrown by the handler are caught and converted to error frames so
   * the caller always receives a terminal, regardless of handler behaviour.
   */
  private async runSyscall(
    syscall: Syscall,
    request: Frame,
    caller: Caller,
    cancel: AbortController
  ): Promise<void> {
    let sentTerminal = false;

    try {
      for await (const response of syscall.dispatch(request, caller, cancel.signal)) {
        const normalized = normalizeResponse(request, response);
        await this.emitResponse(normalized);
        if (isTerminalStatus(normalized.status)) {
          sentTerminal = true;
          break;
        }
      }

      if (!sentTerminal && !cancel.signal.aborted) {
        await this.emitResponse(
          responseFrom(
            request,
            "error",
            KernelError.internal("handler exited without terminal frame").toData()
          )
        );
      }
    } catch (error) {
      await this.emitResponse(
        responseFrom(request, "error", toKernelError(error).toData())
      );
    } finally {
      this.active.delete(request.id);
    }
  }

  /**
   * Processes a cancel frame by aborting the active handler and emitting a
   * terminal cancel response to the originating caller.
   *
   * For pipe and sigcall routes, the cancel frame is also forwarded into the
   * handler's inbound queue so the handler can react to the cancellation
   * explicitly (e.g. clean up resources).
   */
  private async routeCancel(frame: Frame): Promise<void> {
    const targetId = frame.parent_id;
    if (targetId === undefined) {
      return;
    }

    const active = this.active.get(targetId);
    if (active === undefined) {
      return;
    }

    active.cancel.abort();

    if (active.route === "pipe" || active.route === "sigcall") {
      active.pipe?.push(frame);
    }

    this.active.delete(targetId);
    await this.emitResponse(responseFrom(active.request, "cancel", {}));
  }

  /**
   * Delivers a response frame to the pending caller stream identified by
   * `parent_id` and broadcasts it to all subscribers.
   *
   * When a terminal frame arrives, the corresponding pending entry and active
   * entry are removed to free memory. The stream is closed via `stream.close()`
   * (not just queue close) so registered cleanup callbacks fire.
   */
  private async emitResponse(frame: Frame): Promise<void> {
    const parentId = frame.parent_id;
    if (parentId !== undefined) {
      const pending = this.pending.get(parentId);
      if (pending !== undefined) {
        pending.queue.push(frame);
        if (isTerminalStatus(frame.status)) {
          pending.stream.close();
        }
      }
    }

    await this.subscribers.deliver(frame);

    if (isTerminalStatus(frame.status) && parentId !== undefined) {
      this.active.delete(parentId);
      this.pending.delete(parentId);
    }
  }

  /**
   * Handles frames addressed to the reserved `sigcall:` namespace.
   *
   * Only `sigcall:list` is supported via frame dispatch. `sigcall:register`
   * and `sigcall:unregister` must be called through the `SigcallRegistry`
   * API directly because they require returning a `PipeEnd` object, which
   * cannot be encoded in a frame payload.
   */
  private async handleSigcallManagement(frame: Frame): Promise<void> {
    const verb = verbOf(frame.call);

    switch (verb) {
      case "list":
        for (const entry of this.sigcallRegistry.list()) {
          await this.emitResponse(responseFrom(frame, "item", {
            name: entry.name,
            owner: entry.owner
          }));
        }
        await this.emitResponse(responseFrom(frame, "done", {}));
        return;
      case "register":
      case "unregister":
        await this.emitResponse(responseFrom(frame, "error", {
          code: "E_INTERNAL",
          message: "sigcall:register and sigcall:unregister must be called through the SigcallRegistry API directly",
          retryable: false
        }));
        return;
      default:
        await this.emitResponse(responseFrom(frame, "error", {
          code: "E_INTERNAL",
          message: `unknown sigcall operation: ${verb}`,
          retryable: false
        }));
      }
  }
}
