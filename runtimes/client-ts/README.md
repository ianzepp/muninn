# muninn-client-ts

Transport-agnostic TypeScript client for Muninn frame servers.

`muninn-client-ts` is the TypeScript client package in the Muninn family:

- **`muninn-frames-ts`** — shared frame model and JSON codec
- **`muninn-client-ts`** — client connection, request/response correlation, stream API
- **`muninn-kernel-ts`** — in-process routing and handler execution

This package provides a small ESM client for browser and Node environments. It
handles connection setup, request framing, response correlation via `parent_id`,
and async stream consumption. The default transport is WebSocket, and custom
transports can be injected with a `TransportFactory`.

## Installation

```bash
npm install muninn-client-ts muninn-frames-ts
```

## Library Use

`muninn-client-ts` is packaged as a small ESM library with type declarations:

- runtime entry: `dist/index.js`
- types entry: `dist/index.d.ts`
- package export: `"muninn-client-ts"`

Published builds include only the library artifacts under `dist/`; tests are
not part of the shipped package.

Typical usage:

```ts
import { Client, type Frame } from "muninn-client-ts";

const client = await Client.connect("ws://localhost:8080");
const frames: Frame[] = await client.collect("echo:ping", { input: true });
client.close();
```

## Public API

```ts
export { Client } from "muninn-client-ts";
export type { ClientOptions, CallOptions } from "muninn-client-ts";
export { ClientStream } from "muninn-client-ts";
export type { Transport, TransportFactory } from "muninn-client-ts";
export { WebSocketTransport } from "muninn-client-ts";
```

The package also re-exports frame types and codec helpers from
`muninn-frames-ts` for convenience.

## Transport Model

`Client.connect()` opens a single transport connection and returns a `Client`.
Each `call()` creates a request frame, sends it over the transport, and returns
a `ClientStream` that yields responses until a terminal frame arrives.

Built-in helpers:

- `call()` — returns an async iterable stream
- `collect()` — gathers all frames until terminal status
- `first()` — returns the first response frame, then closes the stream

## Environment Notes

The built-in `WebSocketTransport` uses the global `WebSocket` constructor:

- browsers: supported natively
- Node.js: supported with the built-in global in modern Node versions

If your runtime does not provide a compatible global `WebSocket`, inject a
custom transport factory.

## Status

The API is intentionally small and early-stage. Pin to a tag or revision rather
than tracking a moving branch.
