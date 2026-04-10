/**
 * Error taxonomy for the muninn-kernel-ts microkernel.
 *
 * Two error classes cover the two distinct failure domains:
 * - `SigcallError`: violated ownership or naming rules in the dynamic handler registry
 * - `KernelError`: all runtime routing and dispatch failures
 *
 * `KernelError` implements `ErrorCode` so it can round-trip cleanly through
 * the frame wire format: every error frame carries `code`, `message`, and
 * `retryable` in its `data` payload. `toKernelError` normalises arbitrary
 * thrown values into this representation before they reach the caller's stream.
 */

import type { JsonObject } from "muninn-frames-ts";

// ---------------------------------------------------------------------------
// ErrorCode — optional interface for domain errors that carry a machine-readable code
// ---------------------------------------------------------------------------

/**
 * Optional interface for errors that carry a machine-readable classification.
 *
 * Implementing `errorCode()` allows `toKernelError` to preserve the original
 * error code when wrapping a non-`KernelError` into the kernel's error model,
 * rather than collapsing everything to `E_INTERNAL`.
 */
export interface ErrorCode extends Error {
  /** Returns a stable, upper-snake-case error code (e.g. `"E_NOT_FOUND"`). */
  errorCode(): string;
  /** When present and returns `true`, callers may safely retry the operation. */
  retryable?(): boolean;
}

// ---------------------------------------------------------------------------
// SigcallError — violations of dynamic handler registry rules
// ---------------------------------------------------------------------------

/**
 * Thrown when a `SigcallRegistry` operation violates ownership or naming rules.
 *
 * All instances are created via static factory methods to keep error messages
 * consistent and machine-grep-able across the codebase.
 */
export class SigcallError extends Error {
  /** The caller attempted to register a name that another owner already holds. */
  static alreadyRegistered(name: string, owner: string): SigcallError {
    return new SigcallError(`sigcall ${JSON.stringify(name)} already registered by ${JSON.stringify(owner)}`);
  }

  /** The caller attempted to unregister a name that has no active registration. */
  static notRegistered(name: string): SigcallError {
    return new SigcallError(`sigcall ${JSON.stringify(name)} not registered`);
  }

  /** The caller attempted to unregister a name it does not own. */
  static notOwner(name: string, owner: string, caller: string): SigcallError {
    return new SigcallError(
      `sigcall ${JSON.stringify(name)} owned by ${JSON.stringify(owner)}, not ${JSON.stringify(caller)}`
    );
  }

  /** The caller attempted to register a name in the reserved `sigcall:` namespace. */
  static reserved(name: string): SigcallError {
    return new SigcallError(`cannot register reserved prefix: ${JSON.stringify(name)}`);
  }
}

// ---------------------------------------------------------------------------
// KernelError — structured runtime errors that serialise into frame data payloads
// ---------------------------------------------------------------------------

/**
 * Structured error carrying a stable code, human-readable message, and a
 * retryability flag — all three fields serialise directly into an error
 * frame's `data` payload via `toData()`.
 *
 * Use the static factory methods instead of the constructor so callers can
 * distinguish error categories by code without parsing message strings.
 */
export class KernelError extends Error implements ErrorCode {
  readonly code: string;
  readonly retryableFlag: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "KernelError";
    this.code = code;
    this.retryableFlag = retryable;
  }

  /** Caller supplied structurally invalid arguments. */
  static invalidArgs(message: string): KernelError {
    return new KernelError("E_INVALID_ARGS", message);
  }

  /** The requested resource or handler does not exist. */
  static notFound(message: string): KernelError {
    return new KernelError("E_NOT_FOUND", message);
  }

  /** The operation is not permitted for the calling context. */
  static forbidden(message: string): KernelError {
    return new KernelError("E_FORBIDDEN", message);
  }

  /** The operation was cancelled, either by the caller or the kernel. */
  static cancelled(message = "operation cancelled"): KernelError {
    return new KernelError("E_CANCELLED", message);
  }

  /**
   * A transient timeout occurred; marked retryable so callers can distinguish
   * it from permanent failures.
   */
  static timeout(message: string): KernelError {
    return new KernelError("E_TIMEOUT", message, true);
  }

  /** An unexpected internal failure — should not occur under normal operation. */
  static internal(message: string): KernelError {
    return new KernelError("E_INTERNAL", message);
  }

  /** No registered syscall, pipe, or sigcall handler exists for the frame's prefix. */
  static noRoute(message: string): KernelError {
    return new KernelError("E_NO_ROUTE", message);
  }

  errorCode(): string {
    return this.code;
  }

  retryable(): boolean {
    return this.retryableFlag;
  }

  /**
   * Serialises this error into a `JsonObject` suitable for use as an error
   * frame's `data` payload.
   */
  toData(): JsonObject {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryableFlag
    };
  }
}

// ---------------------------------------------------------------------------
// toKernelError — normalises arbitrary thrown values into KernelError
// ---------------------------------------------------------------------------

/**
 * Coerces any thrown value into a `KernelError`.
 *
 * Preserves the original `errorCode` and `retryable` classification when the
 * source implements `ErrorCode`, so domain-specific errors survive the
 * normalisation without losing their machine-readable codes.
 * Falls back to `E_INTERNAL` for plain `Error` instances and unknown values.
 *
 * @param error - The caught value, which may be any type.
 */
export function toKernelError(error: unknown): KernelError {
  if (error instanceof KernelError) {
    return error;
  }

  if (error instanceof Error) {
    if (hasErrorCode(error)) {
      return new KernelError(
        error.errorCode(),
        error.message,
        error.retryable?.() ?? false
      );
    }

    return KernelError.internal(error.message);
  }

  return KernelError.internal("unknown error");
}

function hasErrorCode(error: Error): error is ErrorCode {
  return typeof (error as Partial<ErrorCode>).errorCode === "function";
}
