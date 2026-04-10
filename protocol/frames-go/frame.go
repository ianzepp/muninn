// Package muninnframes defines the shared frame protocol for Muninn clients
// and services written in Go.
//
// # Architecture overview
//
// Muninn is a stream-first async messaging system. Every interaction —
// whether a single RPC or a long-running result stream — is carried by a
// sequence of Frames. A sender emits one StatusRequest frame; the receiver
// replies with zero or more StatusItem / StatusBulk frames and closes the
// stream with exactly one terminal frame (StatusDone, StatusError, or
// StatusCancel).
//
// This package is the Go member of the Muninn frame family:
//
//   - muninn-frames     — Rust wire frame model and protobuf codec
//   - muninn-frames-go  — Go frame model with JSON encode/decode (this package)
//   - muninn-frames-ts  — TypeScript frame model for browser and Node clients
//
// # System context
//
// This package sits at the serialization boundary. It receives raw JSON bytes
// from a transport (HTTP, WebSocket, in-process channel) and produces
// validated Frame values ready for business logic, or the reverse. It does not
// implement the in-memory kernel runtime, routing, or subscription management.
//
// # Design philosophy
//
// The package surface is intentionally small: one struct, one status enum,
// validation, and two codec helpers. Keeping the surface narrow means every
// Muninn service and client can depend on this package without pulling in
// runtime concerns. Protobuf parity with the Rust crate can be added later if
// exact wire compatibility is needed.
//
// # Trade-offs
//
// JSON is used rather than protobuf because the current Go consumers are HTTP
// and WebSocket clients where human-readable wire data simplifies debugging.
// The Rust crate handles binary protobuf for high-throughput paths; Go
// services use this JSON codec unless they need to interoperate with those
// protobuf streams directly.
package muninnframes

import (
	"encoding/json"
	"errors"
	"fmt"
)

// ---------------------------------------------------------------------------
// Status — lifecycle state of a frame in a request/response stream
//
// Status is defined as a string alias rather than an integer enum so that wire
// values are self-describing across language boundaries. The Rust and
// TypeScript siblings use the same lowercase strings, which means a frame
// serialized in any language can be decoded by any other without a shared
// mapping table.
// ---------------------------------------------------------------------------

// Status represents the lifecycle state of a Frame as it moves through a
// Muninn request/response exchange.
//
// The allowed transitions are:
//
//	StatusRequest  →  StatusItem* | StatusBulk*  →  StatusDone | StatusError | StatusCancel
//
// A stream consumer should call IsTerminal to decide when to stop reading.
// Using a typed alias instead of bare string forces call-sites through
// IsValid and the custom JSON codec, preventing unknown states from
// propagating silently into business logic.
type Status string

// Status constants define every valid lifecycle state. They are grouped below
// in the order they appear in a stream to make the lifecycle visible at a
// glance.
//
// Non-terminal states (may be followed by more frames):
//
//   - StatusRequest — the initiating frame sent by a caller.
//   - StatusItem   — a single result item in a streaming response.
//   - StatusBulk   — a batch of result items delivered together to reduce
//     round-trip overhead when the full result set is available immediately.
//
// Terminal states (exactly one closes every stream):
//
//   - StatusDone   — all results delivered; stream closed cleanly.
//   - StatusError  — processing failed; the Data map carries error details.
//   - StatusCancel — the caller or an intermediary aborted the stream before
//     completion.
const (
	StatusRequest Status = "request"
	StatusItem    Status = "item"
	StatusBulk    Status = "bulk"
	StatusDone    Status = "done"
	StatusError   Status = "error"
	StatusCancel  Status = "cancel"
)

// ---------------------------------------------------------------------------
// Error types
//
// Two error values are defined at this layer:
//
//  1. ErrInvalidStatus — a sentinel suitable for errors.Is unwrapping. Used
//     whenever a Status value is outside the supported set, whether that
//     originates from JSON decoding or from a Validate call. Having a single
//     sentinel lets callers distinguish "bad status" from other validation
//     failures without string matching.
//
//  2. ValidationError — a struct error that carries the field name as a
//     machine-readable value. Callers that want to surface field-level
//     feedback (HTTP 422 responses, client-side form errors) can type-assert
//     to ValidationError without parsing the error string.
// ---------------------------------------------------------------------------

// ErrInvalidStatus is the sentinel error returned when a Status value is not
// one of the six supported variants. It is always wrapped with fmt.Errorf so
// that the offending value is included in the message, while still being
// matchable via errors.Is(err, ErrInvalidStatus).
var ErrInvalidStatus = errors.New("invalid frame status")

// ValidationError is returned by Validate when a required Frame field is
// missing or structurally malformed.
//
// Field is the JSON field name (e.g. "id", "call") rather than the Go struct
// field name so that error messages map directly to what a client sent over
// the wire.
type ValidationError struct {
	Field   string
	Message string
}

// Error implements the error interface.
func (e ValidationError) Error() string {
	return fmt.Sprintf("invalid frame %s: %s", e.Field, e.Message)
}

// ---------------------------------------------------------------------------
// Frame — the shared envelope for every Muninn message
//
// Frame is the single data structure that crosses every boundary in the Muninn
// system: client-to-service, service-to-service, and service-to-client. Its
// field layout is deliberately identical to the Rust muninn-frames schema so
// that JSON round-trips between Go and Rust produce bit-for-bit equivalent
// payloads without a translation layer.
// ---------------------------------------------------------------------------

// Frame is the shared envelope for every Muninn request and response.
//
// Every frame in a stream shares the same Call and, for response frames, the
// same ParentID that refers back to the originating request. This correlation
// pair is how consumers route streaming results back to the correct caller
// without a stateful session.
//
// Field notes:
//
//   - ID: unique identifier for this frame, typically a UUID. Required.
//
//   - ParentID: the ID of the request frame that triggered this response.
//     Nil on outbound request frames. Pointer rather than empty string so that
//     JSON omitempty can suppress the field cleanly and consumers can
//     distinguish "not set" from "explicitly empty".
//
//   - CreatedMS: Unix time in milliseconds at frame creation. Millisecond
//     precision matches the Rust schema and avoids the sub-millisecond
//     ambiguity that arises when different runtimes format fractional seconds.
//
//   - ExpiresIn: milliseconds from CreatedMS until the frame is considered
//     stale. Zero means no expiry. Stored as a duration rather than an
//     absolute timestamp so receivers with clock skew can still apply the
//     TTL correctly relative to their own wall clock.
//
//   - From: optional identifier of the sender (user, service, or session).
//     Pointer for the same reason as ParentID — omitted from JSON when nil.
//
//   - Call: the operation being requested or responded to, e.g. "object:create".
//     Required. Namespaced with a colon by convention to group related calls.
//
//   - Status: the lifecycle state of this frame. Required.
//
//   - Trace: arbitrary diagnostic metadata attached by intermediaries (routers,
//     middleware, tracing agents). Typed as any because trace schemas vary per
//     deployment and must not constrain the frame protocol itself.
//
//   - Data: the business payload. Typed as map[string]any rather than a
//     concrete struct because Frame is a protocol envelope shared across every
//     call type. Callers decode Data into a typed struct after routing. Scalar
//     JSON values and top-level arrays are not valid — Data must always be a
//     JSON object, enforced by Validate and by Go's json.Unmarshal behaviour
//     when the target type is map[string]any.
type Frame struct {
	ID        string         `json:"id"`
	ParentID  *string        `json:"parent_id,omitempty"`
	CreatedMS int64          `json:"created_ms"`
	ExpiresIn int64          `json:"expires_in"`
	From      *string        `json:"from,omitempty"`
	Call      string         `json:"call"`
	Status    Status         `json:"status"`
	Trace     any            `json:"trace,omitempty"`
	Data      map[string]any `json:"data"`
}

// ---------------------------------------------------------------------------
// Status methods
// ---------------------------------------------------------------------------

// IsTerminal reports whether this status closes a response stream.
//
// Stream consumers should call IsTerminal after processing each received frame
// to know when to stop reading. Checking this once per frame is cheaper and
// less error-prone than maintaining a parallel set of sentinel comparisons at
// every call site.
func (s Status) IsTerminal() bool {
	return s == StatusDone || s == StatusError || s == StatusCancel
}

// IsValid reports whether the status is one of the six supported variants.
//
// IsValid is used internally by MarshalJSON, UnmarshalJSON, and Validate.
// It is also exported so callers that receive a Status from an external source
// (configuration, a database row) can guard against unknowns before
// constructing a Frame.
func (s Status) IsValid() bool {
	switch s {
	case StatusRequest, StatusItem, StatusBulk, StatusDone, StatusError, StatusCancel:
		return true
	default:
		return false
	}
}

// MarshalJSON serializes the status as a lowercase JSON string.
//
// A custom marshaler is used rather than relying on the default string
// serialization because it enforces the closed set of valid values at
// encode time. Without this guard, a zero-value or programmatically
// constructed Status with an arbitrary string would silently produce
// invalid wire data that remote receivers would reject.
func (s Status) MarshalJSON() ([]byte, error) {
	if !s.IsValid() {
		return nil, fmt.Errorf("%w: %q", ErrInvalidStatus, string(s))
	}

	return json.Marshal(string(s))
}

// UnmarshalJSON parses a lowercase JSON string into a Status.
//
// A custom unmarshaler is used for the same reason as MarshalJSON: to reject
// unrecognised status strings at the deserialization boundary rather than
// allowing them to propagate into business logic as an unchecked string. The
// error is wrapped with ErrInvalidStatus so callers can match it with
// errors.Is without inspecting the message text.
func (s *Status) UnmarshalJSON(data []byte) error {
	var value string
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}

	status := Status(value)
	if !status.IsValid() {
		return fmt.Errorf("%w: %q", ErrInvalidStatus, value)
	}

	*s = status
	return nil
}

// ---------------------------------------------------------------------------
// Frame validation and codec
//
// Validation is intentionally minimal: it checks only the fields that must be
// present for any frame to be routable and processable regardless of call
// type. Call-specific payload validation (e.g. required Data keys) belongs in
// the service handler, not in the shared protocol layer.
// ---------------------------------------------------------------------------

// Validate checks that the frame satisfies the minimal protocol requirements.
//
// The required fields are:
//
//   - ID: every frame must be uniquely identifiable for correlation and dedup.
//   - Call: every frame must name the operation so it can be routed.
//   - Status: must be one of the six supported variants.
//   - Data: must be a non-nil map. Nil is rejected rather than treated as an
//     empty object because a nil Data almost always indicates a construction
//     error; accepting it silently would hide bugs at the call-site.
//
// Fields that are intentionally not validated here: ParentID, From, CreatedMS,
// ExpiresIn, and Trace. These are optional or have semantically valid zero
// values (zero CreatedMS is unusual but not prohibited at the protocol level).
func (f Frame) Validate() error {
	if f.ID == "" {
		return ValidationError{Field: "id", Message: "must not be empty"}
	}
	if f.Call == "" {
		return ValidationError{Field: "call", Message: "must not be empty"}
	}
	if !f.Status.IsValid() {
		return fmt.Errorf("%w: %q", ErrInvalidStatus, string(f.Status))
	}
	if f.Data == nil {
		return ValidationError{Field: "data", Message: "must not be nil"}
	}
	return nil
}

// EncodeFrame validates the frame and serializes it to JSON bytes.
//
// Validation is performed before marshaling so that invalid frames are caught
// before any partial output is produced. This is preferable to relying solely
// on MarshalJSON validation because Validate also checks fields (ID, Call,
// Data) that the standard JSON encoder would not reject.
//
// Returns a ValidationError or ErrInvalidStatus (wrapped) if validation fails,
// or a json.MarshalerError if marshaling itself fails.
func EncodeFrame(frame Frame) ([]byte, error) {
	if err := frame.Validate(); err != nil {
		return nil, err
	}

	return json.Marshal(frame)
}

// DecodeFrame parses JSON bytes into a validated Frame.
//
// Validation is performed after unmarshaling so that frames arriving over the
// wire with structurally valid JSON but missing required fields are caught at
// this boundary. Callers receive either a fully valid Frame or an error; there
// is no partially-decoded intermediate state to handle.
//
// Returns a json.UnmarshalTypeError or json.SyntaxError if the bytes are not
// valid JSON, ErrInvalidStatus (wrapped) if the status string is unrecognised,
// or a ValidationError if a required field is missing.
func DecodeFrame(data []byte) (Frame, error) {
	var frame Frame
	if err := json.Unmarshal(data, &frame); err != nil {
		return Frame{}, err
	}

	if err := frame.Validate(); err != nil {
		return Frame{}, err
	}

	return frame, nil
}
