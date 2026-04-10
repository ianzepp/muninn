# muninn-kernel-ts

Transport-agnostic microkernel for routing in-memory frames between TypeScript subsystems.

`muninn-kernel-ts` is the TypeScript sibling of `muninn-kernel` in the Muninn messaging stack:

- **`muninn-kernel-ts`** — in-memory routing, cancellation, backpressure, handler registration
- **`muninn-frames-ts`** — shared frame model and JSON codec at transport boundaries

The kernel never serializes frames. It routes native TypeScript objects through async queues and async generators, leaving WebSocket, HTTP, TCP, and JSON concerns entirely to gateway code.

## Installation

```bash
npm install muninn-kernel-ts
```

Or as a git dependency:

```json
"dependencies": {
  "muninn-kernel-ts": "github:ianzepp/muninn-kernel-ts"
}
```

Pin to a specific tag or commit rather than tracking `main`:

```json
"dependencies": {
  "muninn-kernel-ts": "github:ianzepp/muninn-kernel-ts#v0.1.0"
}
```

## Architecture Overview

```
Callers
  │
  ▼ request("prefix:verb")
Kernel
  │  register(), registerPrefix(), sigcalls(), subscribe()
  │
  ▼ dispatch(frame)
Router (single event-loop context)
  ├──▶ Syscall handlers  (registered by prefix, AsyncIterable<Frame>)
  ├──▶ Raw PipeEnds      (registered by prefix, managed by caller)
  ├──▶ SigcallRegistry   (dynamic handler registration at runtime)
  └──▶ Subscribers       (fan-out broadcast with backpressure)
```

**One event-loop context, no locks.** The kernel uses plain `Map` state and async generators — no threads, no mutexes, no deadlocks.

**Prefix-based dispatch.** The call string `"prefix:verb"` is split at the first colon. The kernel does an O(1) lookup by prefix to find the right handler.

**Message-pure.** Frames are TypeScript objects moved through async queues. Serialization happens only at the transport boundary, not inside the kernel.

## Core Concepts

### Frame

`Frame` is the universal in-memory envelope for every request and response. It comes from `muninn-frames-ts`:

```ts
interface Frame {
  id: string;
  parent_id?: string;
  created_ms: number;
  expires_in: number;
  from?: string;
  call: string;
  status: Status;
  trace?: JsonValue;
  data: JsonObject;
}
```

**Status lifecycle:**

```
request  →  item* / bulk*  →  done | error | cancel
```

| Status | Meaning |
|---|---|
| `request` | Initial request from a caller |
| `item` | Intermediate streaming result (non-terminal) |
| `bulk` | Intermediate streaming batch (non-terminal) |
| `done` | Successful terminal response |
| `error` | Error terminal response |
| `cancel` | Cancellation signal |

**Constructing frames:**

```ts
import { request, makeFrame } from "muninn-kernel-ts";

// Create a request frame and get a FrameBuilder for building responses
const req = request("vfs:read", { path: "/home/user/file.txt" });

// FrameBuilder response helpers (auto-set parent_id)
req.item({ chunk: "hello" });
req.bulk({ rows: [...] });
req.done();
req.done({ result: "ok" });
req.error("something went wrong");
req.cancel();

// FrameBuilder field overrides
req.withFrom("user-42");
req.withTrace({ room: "abc" });
req.withData("key", "value");

// Lower-level factory with fine-grained control
const f = makeFrame({ call: "vfs:read", data: { path: "/etc/hosts" } });
```

### Kernel

`Kernel` is the entry point for configuration, registration, and dispatch:

```ts
import { Kernel } from "muninn-kernel-ts";

const kernel = Kernel.create();
// or: new Kernel()

// Register a typed handler
kernel.register(new MyHandler());

// Register a raw subsystem and get a PipeEnd
const pipe = kernel.registerPrefix("db");

// Create a caller for issuing requests
const caller = kernel.caller();

// Create a subscriber for response fan-out
const subscriber = kernel.subscribe();

// Dispatch a frame into the kernel
await kernel.dispatch(req.frame);
```

Custom backpressure settings:

```ts
const kernel = Kernel.create({
  backpressure: {
    highWatermark: 2000,
    lowWatermark: 200,
    stallTimeoutMs: 10_000,
  }
});
```

### Syscall Interface

Implement `Syscall` to handle all requests under a prefix:

```ts
import type { Caller, Frame, Syscall } from "muninn-kernel-ts";
import { request } from "muninn-kernel-ts";

class VfsHandler implements Syscall {
  prefix(): string {
    return "vfs";
  }

  async *dispatch(
    frame: Frame,
    caller: Caller,
    cancel: AbortSignal
  ): AsyncIterable<Frame> {
    const verb = frame.call.split(":")[1] ?? "";

    if (cancel.aborted) {
      yield { ...frame, id: crypto.randomUUID(), parent_id: frame.id, status: "cancel", data: {} };
      return;
    }

    switch (verb) {
      case "read":
        yield { ...frame, id: crypto.randomUUID(), parent_id: frame.id, status: "item", data: { chunk: "hello" } };
        yield { ...frame, id: crypto.randomUUID(), parent_id: frame.id, status: "done", data: {} };
        return;
      default:
        yield { ...frame, id: crypto.randomUUID(), parent_id: frame.id, status: "error",
          data: { code: "E_NOT_FOUND", message: `unknown verb: ${verb}`, retryable: false } };
        return;
    }
  }
}
```

Or more concisely using the `FrameBuilder`:

```ts
import { frame, type Frame, type Syscall, type Caller } from "muninn-kernel-ts";

class EchoHandler implements Syscall {
  prefix() { return "echo"; }

  async *dispatch(req: Frame, _caller: Caller, cancel: AbortSignal): AsyncIterable<Frame> {
    const f = frame(req);
    if (cancel.aborted) { yield f.cancel(); return; }
    yield f.item({ echo: req.data });
    yield f.done();
  }
}
```

The kernel enforces the terminal-frame requirement: if a handler exits without yielding a terminal frame (`done`, `error`, or `cancel`), the kernel synthesizes an `E_INTERNAL` error so the caller's stream never hangs.

### Caller and CallStream

`Caller` issues request frames and returns a `CallStream` for the response sequence:

```ts
const caller = kernel.caller();
const req = request("vfs:read", { path: "/etc/hosts" });

// Stream responses
const stream = caller.call(req.frame);
for await (const frame of stream) {
  console.log(frame.status, frame.data);
  if (frame.status === "done" || frame.status === "error") break;
}

// Collect all frames at once
const frames = await caller.collect(req.frame);

// Get just the first response
const first = await caller.first(req.frame);
```

`CallStream` supports cooperative cancellation via `AbortSignal`:

```ts
const controller = new AbortController();
const stream = caller.call(req.frame, { signal: controller.signal });

// Later — cancel the in-flight request
controller.abort();
```

`CallStream` also exposes explicit helpers:

```ts
const stream = caller.call(req.frame);

// Collect all frames
const frames = await stream.collect();

// Poll one at a time
const frame = await stream.recv();

// Close early
stream.close();

// Register cleanup
stream.onClose(() => cleanup());
```

### Subscriber

`Subscriber` receives every frame the kernel emits — useful for monitoring, logging, or integration testing:

```ts
const subscriber = kernel.subscribe();

// Async iteration
for await (const frame of subscriber) {
  console.log("frame:", frame.status, frame.call);
}

// One-at-a-time polling
const frame = await subscriber.recv();

// Collect until a predicate matches
const frames = await subscriber.collect({
  until: (f) => f.status === "done" && f.call === "vfs:read",
});

// Collect with abort signal
const controller = new AbortController();
const frames = await subscriber.collect({ signal: controller.signal });
```

### PipeEnd

`PipeEnd` is the raw subsystem integration point for handlers that cannot implement the `AsyncIterable<Frame>` generator contract:

```ts
// Register a raw subsystem
const pipe = kernel.registerPrefix("db");

// Read inbound requests
while (true) {
  const frame = await pipe.recv();
  if (frame === undefined) break; // pipe closed

  // Optionally make outbound sub-requests
  const caller = pipe.caller();
  const cacheFrames = await caller.collect(request("cache:get", { key: frame.data.id }).frame);

  // Send a response back into the kernel
  await pipe.send({
    id: crypto.randomUUID(),
    parent_id: frame.id,
    created_ms: Date.now(),
    expires_in: 0,
    call: frame.call,
    status: "done",
    data: { result: "ok" }
  });
}
```

Pipe handlers own the protocol themselves — the kernel does not enforce terminal frames for pipe routes.

### SigcallRegistry

The sigcall registry allows handlers to be registered dynamically at runtime — suitable for plugin systems, connection-scoped handlers, or hot-reloadable services:

```ts
const sigcalls = kernel.sigcalls();

// Register a handler for a specific call
const pipe = sigcalls.register("plugin:process", "conn-abc123");

// Serve requests in a loop
(async () => {
  while (true) {
    const frame = await pipe.recv();
    if (frame === undefined) break;
    await pipe.send({ ...frame, id: crypto.randomUUID(), parent_id: frame.id, status: "done", data: {} });
  }
})();

// Unregister a specific handler
sigcalls.unregister("plugin:process", "conn-abc123");

// Unregister all handlers owned by an identifier (e.g. on disconnect)
sigcalls.unregisterAll("conn-abc123");

// List all active registrations (also available via sigcall:list frame)
const list = sigcalls.list();
```

Ownership rules:
- First registration wins — a different owner cannot shadow an existing registration
- Only the registered owner can unregister a handler
- Names prefixed with `"sigcall:"` are reserved for kernel use

## Error Types

```ts
import { KernelError, SigcallError } from "muninn-kernel-ts";

// KernelError — structured errors with code and retryable flag
KernelError.invalidArgs("missing field: path");
KernelError.notFound("no route for prefix: vfs");
KernelError.forbidden("owner mismatch");
KernelError.cancelled();
KernelError.timeout("subscriber stalled");     // retryable = true
KernelError.internal("unexpected state");
KernelError.noRoute("unknown prefix: xyz");

// SigcallError — dynamic handler registry violations
SigcallError.alreadyRegistered("plugin:process", "other-owner");
SigcallError.notRegistered("plugin:process");
SigcallError.notOwner("plugin:process", "real-owner", "caller");
SigcallError.reserved("sigcall:list");
```

Implement `ErrorCode` on your own error types to preserve machine-readable codes through the frame wire format:

```ts
import type { ErrorCode } from "muninn-kernel-ts";

class MyError extends Error implements ErrorCode {
  errorCode(): string { return "E_MY_ERROR"; }
  retryable(): boolean { return false; }
}
```

## Backpressure

Backpressure is applied per `Subscriber` queue, not globally. One slow subscriber does not block unrelated streams.

```ts
Kernel.create({
  backpressure: {
    highWatermark: 1000,         // stall delivery above this queue depth
    lowWatermark: 100,           // resume delivery below this queue depth
    stallTimeoutMs: 5000,        // evict subscriber after this many ms stalled
  }
});
```

Terminal frames (`done`, `error`, `cancel`) are always delivered regardless of watermark state, and stream tracking is cleaned up immediately after.

## Cancellation

Send a cancel frame via `AbortSignal` or directly through the kernel:

```ts
// Via AbortSignal on a Caller
const controller = new AbortController();
const stream = caller.call(req.frame, { signal: controller.signal });
controller.abort();  // dispatches a cancel frame automatically

// Via direct dispatch (advanced)
await kernel.dispatch({
  id: crypto.randomUUID(),
  parent_id: req.frame.id,
  created_ms: Date.now(),
  expires_in: 0,
  call: req.frame.call,
  status: "cancel",
  data: {}
});
```

The kernel:
1. Aborts the `AbortSignal` passed to the active `Syscall.dispatch` call
2. Delivers a `cancel` frame to subscribers and the pending caller stream
3. Forwards the cancel frame into the handler's inbound queue (for pipe and sigcall routes)
4. Cleans up tracking state for the request

Handlers must observe `cancel.aborted` at yield points — cancellation is cooperative, not preemptive.

## Gateway Pattern

Typical usage in a WebSocket gateway:

```ts
import { Kernel, request } from "muninn-kernel-ts";
import { decodeFrame, encodeFrame, isTerminalStatus } from "muninn-frames-ts";

const kernel = Kernel.create();

// Register subsystems
kernel.register(new VfsHandler());
kernel.register(new EchoHandler());

// Observe all outbound frames
const subscriber = kernel.subscribe();
const caller = kernel.caller();

// Fan-out responses to connected clients
(async () => {
  for await (const frame of subscriber) {
    const json = encodeFrame(frame);
    // forward to the correct WebSocket connection by frame.parent_id
    sendToClient(frame.parent_id, json);
  }
})();

// On incoming WebSocket message
async function onMessage(rawJson: string) {
  const wireFrame = decodeFrame(rawJson);
  // Convert wire frame to kernel frame and dispatch
  await kernel.dispatch(wireFrame as any);
}
```

## Module Reference

| Export | Purpose |
|---|---|
| `Kernel` | Central router — `dispatch()`, `register()`, `registerPrefix()`, `caller()`, `subscribe()`, `sigcalls()` |
| `Caller` / `CallStream` | Outbound request API — `call()`, `collect()`, `first()` |
| `Syscall` | Interface for static prefix handlers using `AsyncIterable<Frame>` |
| `PipeEnd` | External handle for pipe-registered prefixes — `recv()`, `send()`, `caller()` |
| `Subscriber` | Broadcast consumer — `recv()`, `collect()`, async iteration |
| `SigcallRegistry` | Dynamic handler registry — `register()`, `unregister()`, `unregisterAll()`, `list()` |
| `FrameBuilder` | Fluent response-frame factory — `item()`, `bulk()`, `done()`, `error()`, `cancel()` |
| `request()` | Primary frame factory — creates a request frame and returns a `FrameBuilder` |
| `frame()` | Wraps an existing frame in a `FrameBuilder` for response helpers |
| `makeFrame()` | Low-level frame factory with fine-grained control over all fields |
| `prefixOf()` / `verbOf()` | Call-string parsers (`"prefix:verb"` → `"prefix"` / `"verb"`) |
| `KernelError` | Structured runtime errors with stable codes and retryability |
| `SigcallError` | Registry ownership and naming violations |
| `ErrorCode` | Interface for domain errors that round-trip through frame wire format |
| Frame types | `Frame`, `Status`, `JsonObject`, `JsonValue`, `JsonPrimitive` (re-exported from `muninn-frames-ts`) |
| Frame codec | `encodeFrame()`, `decodeFrame()`, `validateFrame()`, `isTerminalStatus()`, `isStatus()` (re-exported) |

## Wire Boundary

`muninn-kernel-ts` uses the same logical `Frame` type as `muninn-frames-ts`. When crossing a transport boundary, encode frames with `encodeFrame` and decode with `decodeFrame` from `muninn-frames-ts`. The `muninn-bridge-rs` crate handles the Rust-side conversion for protobuf-encoded wire traffic.

## Status

The API is small and early-stage. Pin to a tag or revision rather than tracking a moving branch. See [`DESIGN.md`](DESIGN.md) for architecture notes and design rationale.
