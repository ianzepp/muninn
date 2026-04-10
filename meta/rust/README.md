# muninn

Umbrella crate for the Muninn core family.

`muninn` is the convenience entrypoint for client projects that want one package for the core stack:

- **`muninn-frames`** — wire frame model and protobuf codec
- **`muninn-kernel`** — in-memory async routing and stream-first messaging
- **`muninn-llm`** — LLM-facing syscalls, room coordination, and ReAct tool loops
- **`muninn-bridge`** — strict boundary conversion between kernel and wire frames

This crate contains no additional runtime behavior. It exists to pin a known-good set of core crate versions and re-export them behind feature flags.

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
muninn = { git = "https://github.com/ianzepp/muninn.git", features = ["frames", "kernel", "bridge"] }
```

If you only want part of the stack, enable just the relevant features:

```toml
[dependencies]
muninn = { git = "https://github.com/ianzepp/muninn.git", features = ["kernel"] }
```

Pin to a specific tag or commit rather than tracking `main`:

```toml
[dependencies]
muninn = { git = "https://github.com/ianzepp/muninn.git", tag = "v0.1.0", features = ["frames", "kernel", "bridge"] }
```

## Public API

The public surface is feature-gated re-exports:

```rust
#[cfg(feature = "frames")]
pub use muninn_frames as frames;

#[cfg(feature = "kernel")]
pub use muninn_kernel as kernel;

#[cfg(feature = "llm")]
pub use muninn_llm as llm;

#[cfg(feature = "bridge")]
pub use muninn_bridge as bridge;
```

## Feature Flags

| Feature | Enables |
|---|---|
| `frames` | `muninn::frames` |
| `kernel` | `muninn::kernel` |
| `llm` | `muninn::llm` |
| `bridge` | `muninn::bridge` plus `frames` and `kernel` |

## Usage

### Full Core Stack

```rust
use muninn::bridge::decode_to_kernel;
use muninn::kernel::Frame;

let request = Frame::request("object:list");
let _kernel_frame = decode_to_kernel(&incoming_bytes)?;
```

### Kernel-Only Client

```rust
use muninn::kernel::{Frame, Kernel};

let mut kernel = Kernel::new();
let request = Frame::request("health:check");
let sender = kernel.sender();
```

### Explicit Wire Boundary

```rust
use muninn::bridge::encode_from_kernel;
use muninn::kernel::Frame;

let frame = Frame::request("chat:send");
let bytes = encode_from_kernel(&frame);
```

## Design

Muninn is stream-first:

- the canonical protocol is the in-memory `muninn-kernel::Frame`
- request handling is async-first and response-stream oriented
- sync or collect/block behavior is derived above that core model
- wire serialization is reserved for mandatory transport boundaries

That means many client projects can stay entirely inside `muninn::kernel` until they reach a socket, HTTP, or other external boundary.

## Status

This crate is intentionally minimal. Its job is packaging and re-export, not policy. Pin to a tag or revision rather than tracking a moving branch.
