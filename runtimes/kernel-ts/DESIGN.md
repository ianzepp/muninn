# muninn-kernel-ts Design Proposal

## Goal

Create a TypeScript sibling of `muninn-kernel` that stays recognizably in the Muninn family while adopting TypeScript-native async generator patterns proven in `monk-os-kernel`.

The design target is:

- **protocol and routing model from Muninn**
- **stream execution style from Monk OS**
- **no OS-specific surface area**

This should be a reusable application microkernel for TypeScript projects, not a renamed operating-system runtime.

---

## Source References

The implementation should be built with the following source files open as primary references.

### Muninn Rust References

These define the family-level semantics that `muninn-kernel-ts` should stay aligned with:

- [`muninn-kernel/src/frame.rs`](/Users/ianzepp/github/ianzepp/muninn-kernel/src/frame.rs)
  Canonical in-memory frame model, status lifecycle, `prefix()` / `verb()`, response builders, `trace` vs `data`.
- [`muninn-kernel/src/kernel.rs`](/Users/ianzepp/github/ianzepp/muninn-kernel/src/kernel.rs)
  Kernel registration model, subsystem routing setup, subscriber creation, syscall registration shape.
- [`muninn-kernel/src/pipe.rs`](/Users/ianzepp/github/ianzepp/muninn-kernel/src/pipe.rs)
  `Caller`, `CallStream`, correlation semantics, raw pipe subsystem behavior.
- [`muninn-kernel/src/sender.rs`](/Users/ianzepp/github/ianzepp/muninn-kernel/src/sender.rs)
  Common response-pattern helpers and the distinction between primary stream semantics and convenience adapters.
- [`muninn-kernel/src/backpressure.rs`](/Users/ianzepp/github/ianzepp/muninn-kernel/src/backpressure.rs)
  Subscriber/backpressure design and the expected high-level flow-control behavior.
- [`muninn-kernel/src/error.rs`](/Users/ianzepp/github/ianzepp/muninn-kernel/src/error.rs)
  Structured kernel error model and error code conventions.
- [`muninn-kernel/src/syscall.rs`](/Users/ianzepp/github/ianzepp/muninn-kernel/src/syscall.rs)
  Rust syscall trait shape and subsystem contract.
- [`muninn-frames-ts/src/index.ts`](/Users/ianzepp/github/ianzepp/muninn-frames-ts/src/index.ts)
  TypeScript frame schema and validation surface that `muninn-kernel-ts` should either depend on or re-export cleanly.
- [`muninn-kernel-ts/DESIGN.md`](/Users/ianzepp/github/ianzepp/muninn-kernel-ts/DESIGN.md)
  This document is itself normative for package scope and TS-specific decisions.

### Monk OS References

These are design influence references. They should inform execution style and generator ergonomics, but not expand the scope beyond Muninn.

- [`monk-os-kernel/src/message.ts`](/Users/ianzepp/github/ianzepp/monk-os-kernel/src/message.ts)
  Primary reference for async-generator/message-first execution style, `AsyncIterable` helpers, and terminal stream discipline.
- [`monk-os-kernel/src/dispatch/dispatcher.ts`](/Users/ianzepp/github/ianzepp/monk-os-kernel/src/dispatch/dispatcher.ts)
  Reference for TS-side dispatch structure and separation between runtime core and syscall orchestration.
- [`monk-os-kernel/src/gateway/gateway.ts`](/Users/ianzepp/github/ianzepp/monk-os-kernel/src/gateway/gateway.ts)
  Reference for transport boundary rigor, concurrent request handling, disconnect cleanup, and stream completion invariants.
- [`monk-os-kernel/src/gateway/README.md`](/Users/ianzepp/github/ianzepp/monk-os-kernel/src/gateway/README.md)
  Reference for documented protocol and gateway invariants.

### Guidance On Using These References

- Use the Muninn Rust files as the source of truth for family shape.
- Use the Monk OS files as the source of truth for TS-native stream ergonomics.
- If a Monk OS pattern conflicts with a Muninn Rust semantic invariant, prefer Muninn.
- If a Rust channel-oriented pattern is awkward in TypeScript, prefer Monk-style `AsyncIterable` execution while preserving Muninn semantics.

---

## Design Principles

### 1. Frame Is Canonical

`Frame` is the native in-memory envelope, just like in Rust `muninn-kernel`.

Do not use a generic `{ op, data }` request shape as the core runtime contract.

Why:

- keeps TS aligned with Rust
- preserves `id` / `parent_id` correlation as a first-class invariant
- keeps `trace` separate from `data`
- matches `muninn-frames-ts` cleanly at boundaries
- keeps `data` object-shaped across in-memory and wire usage

### 1a. Data Is Always An Object

`data` is always a key-value JSON object.

It is never:

- a scalar
- a top-level array
- `null`

TypeScript should codify this as:

```ts
export type JsonObject = { [key: string]: JsonValue };
```

and:

```ts
interface Frame {
  data: JsonObject;
}
```

This is a family invariant for `muninn-kernel-ts`, even if some existing wire crates in other languages are still more permissive.

### 2. Stream First

The native operation shape is:

```text
Frame request -> AsyncIterable<Frame> responses -> terminal frame
```

This is the most important TypeScript adaptation. In TS, `AsyncIterable<Frame>` is the natural analogue to the Rust `CallStream`.

### 3. Terminal Status Is Explicit

Keep the Rust Muninn lifecycle:

```text
request -> item* / bulk* -> done | error | cancel
```

Do not import Monk OS response ops like `ok`, `progress`, `redirect`, or `event` into the Muninn core lifecycle.

If richer semantics are needed later, encode them in:

- `call`
- `trace`
- `data.type`

But keep the core status model small and cross-language stable.

### 4. Package Boundaries Stay Muninn-Shaped

The family split should remain:

- `muninn-frames-ts`: shared frame schema and JSON/protocol helpers
- `muninn-kernel-ts`: in-memory routing/runtime
- future optional transport helpers in a separate package

Do not collapse gateway/transport behavior into `muninn-kernel-ts`.

### 5. Adapters Are Secondary

Like both Rust Muninn and Monk OS:

- collect helpers are allowed
- single-result helpers are allowed
- sync/blocking adapters are allowed in Node contexts

But the primary API must stay stream-first.

---

## Scope

## Included in v0

- `Frame`, `Status`, and `JsonObject` re-export or direct dependency on `muninn-frames-ts`
- `Kernel`
- `Syscall`
- `Caller`
- `Subscriber`
- `CallStream` as `AsyncIterable<Frame>`
- cancellation support via `AbortSignal`
- prefix-based routing
- request correlation and response fan-out
- minimal convenience helpers for collecting streams

## Explicitly Excluded in v0

- VFS
- process model
- worker lifecycle
- HAL abstractions
- generic OS handles
- transport servers
- WebSocket/TCP gateway implementation
- auth layer
- metrics/tracing framework
- domain handlers

These belong to Monk OS or higher-level application packages, not the Muninn core.

---

## Comparison

## Rust `muninn-kernel`

Strengths to preserve:

- `Frame` as canonical envelope
- namespaced `call` (`prefix:verb`)
- `parent_id` correlation
- explicit lifecycle status
- prefix-based subsystem routing
- subscriber/backpressure model
- small, reusable runtime scope

Limitations to avoid copying too literally:

- channel-oriented ergonomics where TS generators are cleaner
- Rust-specific sender patterns where TS can yield directly

## `monk-os-kernel`

Strengths to borrow:

- async generator / `AsyncIterable` first
- message-first mental model
- `collectItems()` / `unwrapStream()` style helpers
- explicit terminal stream completion
- rigorous gateway invariants

Things not to import:

- generic response op taxonomy as the core protocol
- process/VFS/HAL surface
- syscall switchboard as the only dispatch style
- OS-specific runtime concerns

---

## Core Types

Assume `Frame` and `Status` come from `muninn-frames-ts` or are re-exported.

```ts
export type CallStream = AsyncIterable<Frame>;

export interface Syscall {
  prefix(): string;
  dispatch(
    frame: Frame,
    caller: Caller,
    cancel: AbortSignal
  ): CallStream;
}
```

This is intentionally more generator-oriented than Rust's `FrameSender`-based dispatch.

Rationale:

- natural in TS
- keeps streaming visible
- avoids building channel-like ceremony just to imitate Rust

Optional helper form:

```ts
export interface FrameSender {
  item(data: JsonObject): Frame;
  bulk(data: JsonObject): Frame;
  done(data?: JsonObject): Frame;
  error(code: string, message: string, retryable?: boolean): Frame;
  cancel(): Frame;
}
```

This can be a pure helper around a request frame, not necessarily a transport sender.

---

## Kernel API Shape

```ts
export interface BackpressureConfig {
  highWatermark: number;
  lowWatermark: number;
  stallTimeoutMs: number;
}

export class Kernel {
  static create(config?: { backpressure?: Partial<BackpressureConfig> }): Kernel;

  register(syscall: Syscall): void;
  registerPrefix(prefix: string): PipeEnd;

  caller(): Caller;
  subscribe(): Subscriber;

  dispatch(frame: Frame): Promise<void>;
}
```

Notes:

- `dispatch(frame)` is the ingress point
- `caller()` provides the request/response-stream API
- `subscribe()` exposes outbound response fan-out
- `registerPrefix()` is the raw subsystem equivalent of Rust pipes

Unlike Rust, TS may not need a separate `start()` that consumes a builder. A constructed `Kernel` can be live immediately because TS runtime setup is lighter.

---

## Caller API

```ts
export class Caller {
  call(frame: Frame, opts?: { signal?: AbortSignal }): CallStream;
  collect(frame: Frame, opts?: { signal?: AbortSignal }): Promise<Frame[]>;
  first(frame: Frame, opts?: { signal?: AbortSignal }): Promise<Frame | undefined>;
}
```

Guidance:

- `call()` is the canonical primitive
- `collect()` and `first()` are convenience adapters
- cancellation should use `AbortSignal`

`collect()` belongs here because it is a clear secondary adapter over the native stream.

---

## Subscriber API

```ts
export class Subscriber implements AsyncIterable<Frame> {
  next(): Promise<IteratorResult<Frame>>;
  [Symbol.asyncIterator](): AsyncIterator<Frame>;

  collect(opts?: {
    until?: (frame: Frame) => boolean;
    signal?: AbortSignal;
  }): Promise<Frame[]>;
}
```

This should feel natural in TS:

- usable in `for await`
- no artificial `recv()`-only API unless added as a convenience alias

Possible compatibility alias:

```ts
recv(): Promise<Frame | undefined>;
```

That is fine to include, but iteration should be first-class.

---

## Pipe / Raw Subsystem API

For parity with Rust:

```ts
export interface PipeEnd {
  send(frame: Frame): Promise<void>;
  recv(): Promise<Frame | undefined>;
  caller(): Caller;
}
```

This exists for:

- embedding raw subsystems
- transport bridges
- application-specific runtime adapters

Internally this can still be implemented with queues and async iterables, but the public surface can remain close to Rust.

---

## Routing Model

Keep the Rust prefix-routing rule:

- `call = "prefix:verb"`
- route by `prefix`
- let handler inspect `verb`

This family trait should not drift.

```ts
function prefixOf(call: string): string;
function verbOf(call: string): string;
```

This is one of the main places where `muninn-kernel-ts` should match Rust closely.

---

## Error Model

Use structured error frames just like Rust Muninn:

```ts
{
  code: "E_NOT_FOUND",
  message: "unknown verb: read",
  retryable: false
}
```

Recommended TS surface:

```ts
export interface ErrorCode extends Error {
  errorCode(): string;
  retryable?(): boolean;
}
```

and a built-in kernel error helper:

```ts
export class KernelError extends Error {
  static invalidArgs(message: string): KernelError;
  static notFound(message: string): KernelError;
  static forbidden(message: string): KernelError;
  static timeout(message: string): KernelError;
  static internal(message: string): KernelError;
  static noRoute(message: string): KernelError;

  readonly code: string;
  readonly retryable: boolean;
}
```

Again, stay close to Rust.

---

## Cancellation Model

Use `AbortSignal` as the TS-native cancellation primitive.

```ts
dispatch(
  frame: Frame,
  caller: Caller,
  cancel: AbortSignal
): AsyncIterable<Frame>
```

This maps well to:

- browser APIs
- Bun/Node APIs
- TS ecosystem expectations

Cancellation frames should still exist in the protocol. `AbortSignal` is the local runtime hook, not a replacement for protocol-level `cancel`.

---

## Backpressure

Backpressure should exist, but v0 should be conservative.

Recommended v0:

- subscriber queue limits
- configurable high/low watermarks
- stalled consumer timeout
- cleanup on terminal frame

Do not over-engineer this initially. Match the Rust semantics where practical, but keep the implementation simple enough for TS.

---

## Recommended Internal Implementation

Use TS-native primitives:

- async iterables
- internal queues
- deferred promises
- `AbortController`

Avoid:

- pretending TS has Rust channels
- forcing all internals through event emitters
- hiding streaming behind promise-only APIs

The internal architecture can be generator-centric even if some public APIs stay Rust-familiar.

---

## Example Handler

```ts
class VfsSyscall implements Syscall {
  prefix(): string {
    return "vfs";
  }

  async *dispatch(frame: Frame, caller: Caller, cancel: AbortSignal): AsyncIterable<Frame> {
    const verb = frame.call.split(":")[1] ?? "";

    if (cancel.aborted) {
      yield frame.cancel();
      return;
    }

    switch (verb) {
      case "read":
        yield frame.item({ chunk: "hello" });
        yield frame.done();
        return;
      default:
        yield frame.error("unknown verb");
        return;
    }
  }
}
```

This example shows the desired synthesis:

- Muninn frame model
- TS async generator execution

---

## Family Alignment Rules

To keep `muninn-kernel-ts` in the same family as Rust:

1. `Frame` semantics must match Rust.
2. `Status` lifecycle must match Rust.
3. `call` namespace routing must match Rust.
4. `trace` and `data` separation must match Rust.
5. request/response correlation must match Rust.
6. stream-first semantics must remain primary.

To keep it idiomatic in TypeScript:

1. `AsyncIterable<Frame>` is the native response stream.
2. cancellation uses `AbortSignal`.
3. iteration should be first-class in subscribers and callers.
4. helper adapters may wrap streams, but must not replace them.

---

## Phased Delivery

## Phase 1

- package scaffold
- `Frame` / `Status` dependency or re-export from `muninn-frames-ts`
- `Kernel`
- `Syscall`
- `Caller.call()`
- `Subscriber`
- basic prefix routing
- tests around lifecycle and correlation

## Phase 2

- raw `PipeEnd`
- collection helpers
- structured `KernelError`
- cancellation support
- basic backpressure

## Phase 3

- transport helper package
- scoped subscribers
- richer stream filtering
- parity review against Rust semantics

---

## Recommendation

Proceed with `muninn-kernel-ts`, but define it as:

- **closer to Rust Muninn in structure**
- **closer to Monk OS in streaming style**

That means:

- do not port Monk OS wholesale
- do not mechanically port Rust channels into TS
- do build a TS-native microkernel with the Muninn frame/routing model

This is the cleanest path to a real TypeScript sibling in the Muninn family.
