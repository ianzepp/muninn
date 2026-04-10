/**
 * Shared frame model and JSON codec for Muninn TypeScript clients.
 *
 * Every message in the Muninn system — whether a request, a streaming response
 * item, or a terminal acknowledgement — travels as a `Frame`. This package
 * defines the canonical TypeScript representation of that envelope and the
 * JSON wire codec used by browser and Node.js clients.
 *
 * System context: this package sits at the boundary between the transport
 * layer (WebSocket, HTTP, or any byte channel) and the application layer.
 * Callers encode outbound frames to JSON strings before writing to the wire
 * and decode inbound JSON strings back to `Frame` objects before processing.
 * `muninn-kernel-ts` imports from this package as its shared frame model.
 *
 * Design philosophy:
 * - One canonical `Frame` interface, no runtime subclasses.
 * - Validate at the edges (encode and decode) so the rest of the system can
 *   treat any `Frame` in memory as already-validated.
 * - Keep the API surface minimal: types + codec + guards.
 *
 * TRADE-OFFS:
 * JSON is the only supported wire format here. Binary (protobuf) transport can
 * be layered on top if needed, but the TypeScript client layer treats JSON as
 * the default transport boundary because it requires no generated code and
 * works in all JavaScript environments.
 */

// ---------------------------------------------------------------------------
// JSON primitive types — lowest-level building blocks for frame payloads
// ---------------------------------------------------------------------------

/**
 * A JSON scalar value: boolean, number, string, or null.
 *
 * Defined separately from `JsonValue` so callers can express intent clearly
 * when they know a field will never be a nested object or array.
 */
export type JsonPrimitive = boolean | number | string | null;

/**
 * Any value that round-trips cleanly through `JSON.stringify` / `JSON.parse`.
 *
 * The recursive definition mirrors the actual JSON grammar: a JSON value is
 * either a primitive, an array of JSON values, or a string-keyed object of
 * JSON values.
 */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/**
 * A JSON object: a string-keyed map whose values are arbitrary JSON.
 *
 * Used as the type of `Frame.data` and `Frame.trace`. The restriction to
 * objects (as opposed to arrays or primitives) reflects the Muninn convention
 * that frame payloads are always key-value maps, never bare scalars or lists.
 */
export type JsonObject = { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Status lifecycle — the ordered set of states a frame can occupy
// ---------------------------------------------------------------------------

/**
 * Tuple of all valid frame lifecycle statuses, defined `as const` so that
 * `Status` can be derived as a precise union type and `isStatus` can validate
 * against this single source of truth at runtime.
 *
 * Lifecycle flow:
 * ```
 * request  →  item* / bulk*  →  done | error | cancel
 * ```
 * `item` and `bulk` are non-terminal streaming statuses. `done`, `error`, and
 * `cancel` are terminal: no further frames should follow in the same request
 * context once one of these is received.
 */
export const STATUSES = [
  "request",
  "item",
  "bulk",
  "done",
  "error",
  "cancel"
] as const;

/**
 * Union of all valid frame lifecycle values, derived from `STATUSES`.
 *
 * Using a derived union (rather than a hand-written string union) ensures
 * that `isStatus`, `STATUSES`, and `Status` can never disagree at the type
 * level — adding a value to `STATUSES` automatically widens `Status`.
 */
export type Status = (typeof STATUSES)[number];

// ---------------------------------------------------------------------------
// Frame — the universal message envelope
// ---------------------------------------------------------------------------

/**
 * The fundamental message envelope for the Muninn protocol.
 *
 * A Frame is the single data shape that flows across every boundary in the
 * system: from client to kernel, from kernel to handler, and back. It carries
 * routing information (`call`, `from`), correlation identifiers (`id`,
 * `parent_id`), lifecycle state (`status`), optional diagnostic context
 * (`trace`), and the actual application payload (`data`).
 *
 * Invariants maintained by this package:
 * - `id` and `call` are non-empty strings (enforced by `validateFrame`).
 * - `status` is one of the values in `STATUSES` (enforced by `validateFrame`).
 * - `data` is always a JSON object — never a scalar, array, or undefined
 *   (enforced by `validateFrame`; `decodeFrame` defaults a missing field to `{}`).
 *
 * Optional fields (`parent_id`, `from`, `trace`) are omitted entirely from
 * the wire when absent to keep payloads minimal.
 */
export interface Frame {
  /** Unique identifier for this specific frame, used by receivers for deduplication. */
  id: string;

  /**
   * Identifier of the originating request frame that this frame responds to.
   *
   * Present on every response frame (`item`, `bulk`, `done`, `error`, `cancel`)
   * so the kernel and callers can correlate responses back to the correct
   * pending stream. Absent on the initial `request` frame itself.
   */
  parent_id?: string;

  /** Unix epoch timestamp in milliseconds when this frame was created. */
  created_ms: number;

  /**
   * Number of milliseconds after `created_ms` at which this frame expires.
   *
   * A value of `0` means the frame does not expire. The kernel may use this
   * field to implement request timeouts, but does not enforce it automatically.
   */
  expires_in: number;

  /**
   * Logical source identity of the sender — typically a service name or user ID.
   *
   * Optional; omitted when the sender identity is not relevant to the operation
   * or is implied by the transport connection.
   */
  from?: string;

  /**
   * Identifies the operation to be performed, in `prefix:verb` format.
   *
   * The prefix routes the frame to the correct handler (e.g. `"fs"`);
   * the verb selects the specific operation within that handler (e.g. `"read"`).
   * Must be non-empty.
   */
  call: string;

  /** Current lifecycle position of this frame within its request/response stream. */
  status: Status;

  /**
   * Arbitrary diagnostic or routing metadata attached by the sender.
   *
   * Not interpreted by the kernel or codec. Preserved verbatim on response
   * frames derived from a request. Useful for distributed tracing identifiers,
   * room or session tags, or other ambient context that should follow the frame.
   */
  trace?: JsonValue;

  /**
   * The application-level payload for this frame.
   *
   * Always a JSON object. Scalar payloads, top-level arrays, and `undefined`
   * are rejected by `validateFrame`. Callers that do not need to send data
   * should use an empty object `{}`.
   */
  data: JsonObject;
}

// ---------------------------------------------------------------------------
// FrameValidationError — structured error for schema violations
// ---------------------------------------------------------------------------

/**
 * Thrown by `validateFrame`, `encodeFrame`, and `decodeFrame` when a frame
 * violates the schema required by the Muninn protocol.
 *
 * The `field` property identifies which frame property failed validation,
 * allowing callers to programmatically distinguish a missing `id` from an
 * invalid `status` without parsing the error message string.
 *
 * This error is intentionally not retryable — a validation failure indicates
 * a programming error in the frame producer, not a transient condition.
 */
export class FrameValidationError extends Error {
  /** The name of the frame field that failed validation (e.g. `"id"`, `"status"`). */
  readonly field: string;

  constructor(field: string, message: string) {
    super(`invalid frame ${field}: ${message}`);
    this.name = "FrameValidationError";
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// Status guards — runtime type narrowing for the Status union
// ---------------------------------------------------------------------------

/**
 * Type guard that narrows an unknown value to `Status`.
 *
 * Validates against the `STATUSES` tuple at runtime, ensuring the guard stays
 * in sync with the canonical status list without maintaining a separate set.
 *
 * @param value - Any value, typically parsed from JSON or received over the wire.
 * @returns `true` when `value` is one of the valid `Status` strings.
 */
export function isStatus(value: unknown): value is Status {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

/**
 * Returns `true` when `status` represents a terminal lifecycle position.
 *
 * Terminal statuses — `done`, `error`, and `cancel` — signal that the
 * request/response stream is closed. No further frames should be emitted or
 * accepted for the same `parent_id` after a terminal frame is received.
 *
 * Non-terminal statuses (`request`, `item`, `bulk`) return `false`.
 *
 * @param status - A validated `Status` value.
 */
export function isTerminalStatus(status: Status): boolean {
  return status === "done" || status === "error" || status === "cancel";
}

// ---------------------------------------------------------------------------
// validateFrame — schema enforcement applied at every encode/decode boundary
// ---------------------------------------------------------------------------

/**
 * Validates that a `Frame` object satisfies the Muninn protocol schema.
 *
 * Called internally by both `encodeFrame` and `decodeFrame` so validation
 * happens at every transport boundary. Callers can also invoke this directly
 * when constructing frames in application code before sending.
 *
 * Checks performed (in order):
 * - `id` must be a non-empty string.
 * - `call` must be a non-empty string.
 * - `status` must be one of the values in `STATUSES`.
 * - `data` must be a plain JSON object (not `undefined`, not an array, not a scalar).
 *
 * @param frame - The frame to validate.
 * @throws `FrameValidationError` on the first schema violation encountered.
 */
export function validateFrame(frame: Frame): void {
  if (frame.id.length === 0) {
    throw new FrameValidationError("id", "must not be empty");
  }
  if (frame.call.length === 0) {
    throw new FrameValidationError("call", "must not be empty");
  }
  if (!isStatus(frame.status)) {
    throw new FrameValidationError("status", "must be a supported lifecycle value");
  }
  if (frame.data === undefined) {
    throw new FrameValidationError("data", "must not be undefined");
  }
  if (typeof frame.data !== "object" || frame.data === null || Array.isArray(frame.data)) {
    throw new FrameValidationError("data", "must be a JSON object");
  }
}

// ---------------------------------------------------------------------------
// encodeFrame / decodeFrame — JSON wire codec
// ---------------------------------------------------------------------------

/**
 * Serialises a validated `Frame` to a JSON string for wire transmission.
 *
 * Validates the frame before serialising so that malformed frames are caught
 * at the point of production rather than silently placed on the wire.
 *
 * @param frame - The frame to encode.
 * @returns A JSON string representation of the frame.
 * @throws `FrameValidationError` if the frame fails schema validation.
 */
export function encodeFrame(frame: Frame): string {
  validateFrame(frame);
  return JSON.stringify(frame);
}

/**
 * Parses a JSON string into a validated `Frame`.
 *
 * Handles two concerns beyond `JSON.parse`:
 * 1. Reconstructs the typed `Frame` object from the loosely-typed parse
 *    result, applying safe defaults for fields that may be absent in older
 *    or minimal wire representations.
 * 2. Validates the resulting frame so callers receive either a fully-valid
 *    `Frame` or a clear `FrameValidationError` — never a partially-populated
 *    object that passes TypeScript checks but violates protocol invariants.
 *
 * PHASE 1: PARSE AND APPLY DEFAULTS
 * Parse the raw JSON and map each field to its typed counterpart. Required
 * fields that are missing fall back to safe zero-values (`""`, `0`, `{}`)
 * so that `validateFrame` can produce a specific, field-named error rather
 * than a generic parse exception.
 *
 * PHASE 2: PRESERVE OPTIONAL FIELDS
 * Copy optional fields (`parent_id`, `from`, `trace`) only when present in
 * the parsed payload. Omitting absent optional fields keeps the in-memory
 * `Frame` clean and prevents `undefined` values from serialising as `null`
 * in a subsequent `encodeFrame` call.
 *
 * PHASE 3: VALIDATE
 * Run full schema validation on the reconstructed frame before returning.
 * A frame that survives this call satisfies all protocol invariants.
 *
 * @param json - A JSON string received from the wire.
 * @returns A fully-validated `Frame` object.
 * @throws `SyntaxError` if `json` is not valid JSON.
 * @throws `FrameValidationError` if the parsed object violates the frame schema.
 */
export function decodeFrame(json: string): Frame {
  // PHASE 1: PARSE AND APPLY DEFAULTS
  // WHY: Cast to Partial<Frame> rather than Frame so TypeScript forces us to
  // handle each missing field explicitly instead of relying on the caller
  // to notice that required fields may be undefined after JSON.parse.
  const parsed = JSON.parse(json) as Partial<Frame>;

  const frame: Frame = {
    id: parsed.id ?? "",
    created_ms: parsed.created_ms ?? 0,
    expires_in: parsed.expires_in ?? 0,
    call: parsed.call ?? "",
    status: parsed.status as Status,
    data: parsed.data === undefined ? {} : (parsed.data as Frame["data"])
  };

  // PHASE 2: PRESERVE OPTIONAL FIELDS
  // WHY: Conditional assignment rather than spread-with-undefined ensures
  // absent optional fields are not present on the object at all, which
  // matters for JSON.stringify round-trips and strict equality checks.
  if (parsed.parent_id !== undefined) {
    frame.parent_id = parsed.parent_id;
  }
  if (parsed.from !== undefined) {
    frame.from = parsed.from;
  }
  if (parsed.trace !== undefined) {
    frame.trace = parsed.trace;
  }

  // PHASE 3: VALIDATE
  validateFrame(frame);
  return frame;
}

// ---------------------------------------------------------------------------
// Internal helpers — not exported; used only within this module
// ---------------------------------------------------------------------------

/**
 * Returns `true` when `value` is a plain, non-null, non-array JSON object.
 *
 * WHY: Centralises the triple-check (typeof, null, Array.isArray) that appears
 * whenever the codebase needs to distinguish a JSON object from other JSON
 * value shapes. Avoids repeating this idiom inline and makes the intent clear.
 *
 * Not exported because callers outside this module should use `validateFrame`
 * rather than reaching into individual field checks.
 */
function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
