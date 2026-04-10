# muninn-frames-go

Shared frame model and JSON codec for Muninn clients and services written in Go.

`muninn-frames-go` is the Go frame package in the Muninn family:

- **`muninn-frames`** — Rust wire frame model and protobuf codec
- **`muninn-frames-go`** — Go frame model with JSON encode/decode and validation
- **`muninn-frames-ts`** — TypeScript frame model for browser and Node clients

This package focuses on the shared logical frame protocol: field names, status lifecycle, correlation semantics, and JSON representation. It does not implement the in-memory kernel runtime.

## Installation

```bash
go get github.com/ianzepp/muninn-frames-go
```

## Public API

The public surface is a frame type, a status enum, validation, and JSON helpers:

```go
type Status string

const (
    StatusRequest Status = "request"
    StatusItem    Status = "item"
    StatusBulk    Status = "bulk"
    StatusDone    Status = "done"
    StatusError   Status = "error"
    StatusCancel  Status = "cancel"
)

type Frame struct { ... }

func (s Status) IsTerminal() bool
func (s Status) IsValid() bool

func (f Frame) Validate() error

func EncodeFrame(frame Frame) ([]byte, error)
func DecodeFrame(data []byte) (Frame, error)
```

## Frame

`Frame` is the shared envelope for requests, streamed responses, and terminal responses:

```go
type Frame struct {
    ID        string
    ParentID  *string
    CreatedMS int64
    ExpiresIn int64
    From      *string
    Call      string
    Status    Status
    Trace     any
    Data      map[string]any
}
```

`Data` is always a key-value JSON object. Scalar values, top-level arrays, and `null` are not valid frame payloads.

JSON field names follow the Rust frame schema exactly:

- `id`
- `parent_id`
- `created_ms`
- `expires_in`
- `from`
- `call`
- `status`
- `trace`
- `data`

## Status Lifecycle

```text
Request  →  Item* / Bulk*  →  Done | Error | Cancel
```

`Item` and `Bulk` are non-terminal. `Done`, `Error`, and `Cancel` are terminal.

## Usage

### Encode / Decode JSON

```go
frame := muninnframes.Frame{
    ID:        "550e8400-e29b-41d4-a716-446655440000",
    CreatedMS: 1709913600000,
    ExpiresIn: 0,
    Call:      "object:create",
    Status:    muninnframes.StatusRequest,
    Data: map[string]any{
        "name": "hello",
    },
}

bytes, err := muninnframes.EncodeFrame(frame)
decoded, err := muninnframes.DecodeFrame(bytes)
```

### Validate a Frame

```go
if err := frame.Validate(); err != nil {
    return err
}
```

## Relationship to Rust Muninn

This package is deliberately narrower than the Rust `muninn-frames` crate. It standardizes the logical frame protocol for Go clients and services. Protobuf parity can be added later if a Go service needs exact wire compatibility with the Rust protobuf codec.

## Status

The API is intentionally small and early-stage. Pin to a tag or revision rather than tracking a moving branch.
