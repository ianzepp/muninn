# muninn-frames-ts

Shared frame model and JSON codec for Muninn browser and Node clients.

`muninn-frames-ts` is the TypeScript frame package in the Muninn family:

- **`muninn-frames`** — Rust wire frame model and protobuf codec
- **`muninn-frames-go`** — Go frame model with JSON encode/decode and validation
- **`muninn-frames-ts`** — TypeScript frame model for browser and Node clients

This package standardizes the logical frame protocol for UI and client-side code: frame fields, lowercase status strings, request/response correlation, and JSON representation.

## Installation

```bash
npm install muninn-frames-ts
```

## Library Use

`muninn-frames-ts` is packaged as a small ESM library with type declarations:

- runtime entry: `dist/index.js`
- types entry: `dist/index.d.ts`
- package export: `"muninn-frames-ts"`

Published builds include only the library artifacts under `dist/`; tests are not part of the shipped package.

Typical client usage:

```ts
import {
  decodeFrame,
  encodeFrame,
  isTerminalStatus,
  type Frame,
  type Status
} from "muninn-frames-ts";
```

If you are building a higher-level Muninn client or gateway, this package is the shared frame/protocol layer. Routing and in-memory execution belong in `muninn-kernel-ts`, not here.

## Public API

```ts
export type Status =
  | "request"
  | "item"
  | "bulk"
  | "done"
  | "error"
  | "cancel";

export type JsonObject = { [key: string]: JsonValue };
export interface Frame { ... }

export function isTerminalStatus(status: Status): boolean;
export function isStatus(value: unknown): value is Status;
export function validateFrame(frame: Frame): void;

export function encodeFrame(frame: Frame): string;
export function decodeFrame(json: string): Frame;
```

## Frame

```ts
export interface Frame {
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

`data` is always a JSON object. Scalar values, top-level arrays, and `null` are not valid frame payloads.

## Status Lifecycle

```text
request  →  item* / bulk*  →  done | error | cancel
```

`item` and `bulk` are non-terminal. `done`, `error`, and `cancel` are terminal.

## Usage

### Encode / Decode JSON

```ts
import { decodeFrame, encodeFrame, type Frame } from "muninn-frames-ts";

const frame: Frame = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  created_ms: Date.now(),
  expires_in: 0,
  call: "object:create",
  status: "request",
  data: {
    name: "hello"
  }
};

const json = encodeFrame(frame);
const decoded = decodeFrame(json);
```

### Validate a Frame

```ts
import { validateFrame } from "muninn-frames-ts";

validateFrame(frame);
```

## Relationship to Rust Muninn

This package matches the shared logical Muninn frame schema. It is intended for browser and TypeScript client use, where JSON transport is often the simplest boundary. Exact protobuf wire compatibility can be added later if a UI or Node client needs it.

## Status

The API is intentionally small and early-stage. Pin to a tag or revision rather than tracking a moving branch.
