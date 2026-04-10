/**
 * Response normalization applied to every frame a syscall handler yields.
 *
 * Syscall handlers produce frames in isolation — they may not set `parent_id`,
 * may leave `call` empty, or may omit `trace`. This module closes those gaps
 * before the kernel routes the frame to the caller's pending stream, ensuring
 * the wire invariants expected by consumers are always met.
 *
 * Normalisation is intentionally a separate step (not part of the `Syscall`
 * interface) so handlers stay simple: they can yield a minimal frame and trust
 * the kernel to attach the correlation metadata.
 */

import type { Frame } from "muninn-frames-ts";
import { validateFrame } from "muninn-frames-ts";

import { KernelError } from "./errors.js";

/**
 * Ensures a handler-yielded frame is a valid, correlation-correct response.
 *
 * Applied by the kernel inside `runSyscall` to every frame before it is
 * delivered to the caller. Three fields are back-filled from the originating
 * request when the handler leaves them unset:
 * - `parent_id` — ties the response to the request for pending-stream routing
 * - `call` — preserves the original call string when the handler yields `""`
 * - `trace` — propagates the caller's trace context when not explicitly overridden
 *
 * @param request - The original inbound request frame.
 * @param response - The frame yielded by the handler.
 * @returns A fully-populated, validated response frame.
 * @throws `KernelError` (E_INTERNAL) if the handler yields a frame with status `"request"`,
 *   which would create a routing loop.
 */
export function normalizeResponse(request: Frame, response: Frame): Frame {
  if (response.status === "request") {
    throw KernelError.internal("syscall yielded request status");
  }

  const normalized: Frame = {
    ...response,
    parent_id: response.parent_id ?? request.id,
    call: response.call.length > 0 ? response.call : request.call
  };

  if (normalized.trace === undefined && request.trace !== undefined) {
    normalized.trace = request.trace;
  }

  validateFrame(normalized);
  return normalized;
}
