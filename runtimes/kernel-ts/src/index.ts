/**
 * Public API surface for the muninn-kernel-ts microkernel library.
 *
 * Re-exports everything a consumer needs to build on top of the kernel:
 * - Frame primitives and construction helpers (from `muninn-frames-ts` and `./frame`)
 * - Error classes (`KernelError`, `SigcallError`) and the `ErrorCode` interface
 * - `Kernel`: the central router — instantiate this first
 * - `Caller` / `CallStream`: outbound request API
 * - `PipeEnd`: external handler interface for pipe-registered prefixes
 * - `SigcallRegistry`: runtime dynamic handler registration
 * - `Subscriber`: broadcast consumer for monitoring and tracing
 * - `Syscall` / `BackpressureConfig`: interfaces for implementing handlers
 */

export {
  type Frame,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  type Status,
  FrameValidationError,
  STATUSES,
  decodeFrame,
  encodeFrame,
  isStatus,
  isTerminalStatus,
  validateFrame
} from "muninn-frames-ts";

export type { ErrorCode } from "./errors.js";
export { KernelError, SigcallError } from "./errors.js";
export {
  FrameBuilder,
  frame,
  makeFrame,
  prefixOf,
  request,
  responseFrom,
  verbOf
} from "./frame.js";
export type { FrameInit } from "./frame.js";
export type { CallOptions } from "./caller.js";
export { CallStream, Caller } from "./caller.js";
export { Kernel } from "./kernel.js";
export { PipeEnd } from "./pipe.js";
export { SigcallRegistry } from "./sigcall.js";
export type { SubscriberCollectOptions } from "./subscriber.js";
export { Subscriber } from "./subscriber.js";
export type { BackpressureConfig, Syscall } from "./types.js";
