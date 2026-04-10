/**
 * Frame construction helpers and re-exports for the muninn-kernel-ts microkernel.
 *
 * A `Frame` is the universal message envelope that flows through the kernel.
 * Every request, response, and cancellation is a Frame. This module provides:
 * - `FrameBuilder`: a fluent wrapper for producing typed response frames
 * - `frame()` / `request()`: primary entry points for creating frames
 * - `makeFrame()`: lower-level factory accepting an `FrameInit` partial
 * - `responseFrom()`: internal utility for deriving a response from a request
 * - `prefixOf()` / `verbOf()`: call-string parsers used by the routing layer
 *
 * Call strings follow the convention `prefix:verb` (e.g. `"fs:read"`).
 * The prefix identifies the handler; the verb identifies the operation.
 */

import {
  type Frame,
  type JsonObject,
  type JsonValue,
  type Status,
  isTerminalStatus,
  validateFrame
} from "muninn-frames-ts";

import type { ErrorCode } from "./errors.js";

export { isTerminalStatus };
export type { Frame, JsonObject, JsonValue, Status };

// ---------------------------------------------------------------------------
// FrameInit — partial input shape for makeFrame()
// ---------------------------------------------------------------------------

/**
 * Partial input accepted by `makeFrame()`. All fields that the kernel can
 * supply automatically (id, created_ms, status) are optional; `call` is the
 * only required field.
 */
export interface FrameInit {
  id?: string;
  parent_id?: string;
  created_ms?: number;
  expires_in?: number;
  from?: string;
  call: string;
  status?: Status;
  trace?: JsonValue;
  data?: JsonObject;
}

// ---------------------------------------------------------------------------
// FrameBuilder — fluent response-frame factory bound to a source request
// ---------------------------------------------------------------------------

/**
 * Fluent helper for producing response frames tied to a specific source frame.
 *
 * Returned by `frame()` and `request()`. Each method produces a new Frame
 * via `responseFrom()`, inheriting `call`, `expires_in`, and `trace` from
 * the bound source frame. Syscall handlers typically use this to yield
 * typed responses without manually repeating correlation fields.
 */
export class FrameBuilder {
  constructor(readonly frame: Frame) {}

  /** Yields a single-record response frame. */
  item(data: JsonObject): Frame {
    return responseFrom(this.frame, "item", data);
  }

  /** Yields a multi-record batch response frame. */
  bulk(data: JsonObject): Frame {
    return responseFrom(this.frame, "bulk", data);
  }

  /** Yields a terminal success frame, optionally carrying result data. */
  done(data: JsonObject = {}): Frame {
    return responseFrom(this.frame, "done", data);
  }

  /**
   * Yields a terminal error frame with a generic `E_INTERNAL` code.
   * Use `errorFrom()` to preserve a structured `ErrorCode` classification.
   *
   * @param message - Human-readable description of the failure.
   */
  error(message: string): Frame {
    return responseFrom(this.frame, "error", {
      code: "E_INTERNAL",
      message,
      retryable: false
    });
  }

  /**
   * Yields a terminal error frame preserving the code and retryability flag
   * from a structured `ErrorCode` domain error.
   *
   * @param error - An error that implements `ErrorCode`.
   */
  errorFrom(error: ErrorCode): Frame {
    return responseFrom(this.frame, "error", {
      code: error.errorCode(),
      message: error.message,
      retryable: error.retryable?.() ?? false
    });
  }

  /** Yields a terminal cancellation frame. */
  cancel(): Frame {
    return responseFrom(this.frame, "cancel", {});
  }

  /** Returns a copy of the bound frame with `from` overridden. */
  withFrom(from: string): Frame {
    return { ...this.frame, from };
  }

  /** Returns a copy of the bound frame with `trace` overridden. */
  withTrace(trace: JsonValue): Frame {
    return { ...this.frame, trace };
  }

  /** Returns a copy of the bound frame with a single data key added or replaced. */
  withData(key: string, value: JsonValue): Frame {
    return { ...this.frame, data: { ...this.frame.data, [key]: value } };
  }
}

// ---------------------------------------------------------------------------
// Public frame factories
// ---------------------------------------------------------------------------

/**
 * Wraps an existing, already-constructed `Frame` in a `FrameBuilder` after
 * validating it. Use this when you have a raw frame from an external source
 * and want fluent response helpers.
 *
 * @param frameValue - A fully-formed frame to wrap.
 * @throws `FrameValidationError` if the frame fails schema validation.
 */
export function frame(frameValue: Frame): FrameBuilder {
  validateFrame(frameValue);
  return new FrameBuilder(frameValue);
}

/**
 * Creates a new `request`-status frame and wraps it in a `FrameBuilder`.
 *
 * This is the primary entry point for callers constructing outbound requests.
 * A fresh UUID and current timestamp are generated automatically.
 *
 * @param call - The call string in `prefix:verb` format.
 * @param data - Optional request payload.
 */
export function request(call: string, data: JsonObject = {}): FrameBuilder {
  return frame({
    id: crypto.randomUUID(),
    created_ms: Date.now(),
    expires_in: 0,
    call,
    status: "request",
    data
  });
}

/**
 * Low-level frame factory that applies defaults for all optional fields.
 * Prefer `request()` for outbound requests; use `makeFrame()` when you need
 * fine-grained control over id, timestamps, or non-request statuses.
 *
 * Optional fields (`parent_id`, `from`, `trace`) are omitted from the frame
 * when not provided, keeping the payload minimal on the wire.
 *
 * @param init - Partial frame specification; `call` is required.
 * @throws `FrameValidationError` if the resulting frame fails schema validation.
 */
export function makeFrame(init: FrameInit): Frame {
  const frameValue: Frame = {
    id: init.id ?? crypto.randomUUID(),
    created_ms: init.created_ms ?? Date.now(),
    expires_in: init.expires_in ?? 0,
    call: init.call,
    status: init.status ?? "request",
    data: init.data ?? {}
  };

  if (init.parent_id !== undefined) {
    frameValue.parent_id = init.parent_id;
  }
  if (init.from !== undefined) {
    frameValue.from = init.from;
  }
  if (init.trace !== undefined) {
    frameValue.trace = init.trace;
  }

  validateFrame(frameValue);
  return frameValue;
}

// ---------------------------------------------------------------------------
// Call-string utilities — used by the kernel's routing layer
// ---------------------------------------------------------------------------

/**
 * Extracts the routing prefix from a `prefix:verb` call string.
 *
 * The prefix is the part before the first colon and is used by the kernel to
 * look up the registered handler. Returns the entire string unchanged when
 * there is no colon.
 *
 * @param call - A call string such as `"fs:read"`.
 */
export function prefixOf(call: string): string {
  return call.split(":", 1)[0] ?? call;
}

/**
 * Extracts the verb from a `prefix:verb` call string.
 *
 * The verb identifies the specific operation within a handler's namespace.
 * Returns `""` when there is no colon separator.
 *
 * @param call - A call string such as `"fs:read"`.
 */
export function verbOf(call: string): string {
  return call.split(":")[1] ?? "";
}

// ---------------------------------------------------------------------------
// responseFrom — internal utility for deriving responses from a request frame
// ---------------------------------------------------------------------------

/**
 * Derives a new response frame from a source request frame.
 *
 * Preserves `call`, `expires_in`, and `trace` from the request and sets
 * `parent_id` to the request's `id` so the kernel can correlate the response
 * back to the correct pending stream. A new UUID and timestamp are generated
 * for every response.
 *
 * @param requestFrame - The originating request frame.
 * @param status - The response status (any non-request status).
 * @param data - The response payload.
 * @throws `FrameValidationError` if the resulting frame fails schema validation.
 */
export function responseFrom(
  requestFrame: Frame,
  status: Exclude<Status, "request">,
  data: JsonObject
): Frame {
  const response: Frame = {
    id: crypto.randomUUID(),
    parent_id: requestFrame.id,
    created_ms: Date.now(),
    expires_in: requestFrame.expires_in,
    call: requestFrame.call,
    status,
    data
  };

  if (requestFrame.trace !== undefined) {
    response.trace = requestFrame.trace;
  }

  validateFrame(response);
  return response;
}
