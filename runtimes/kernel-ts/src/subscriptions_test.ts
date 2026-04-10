import test from "node:test";
import assert from "node:assert/strict";

import type { Frame } from "muninn-frames-ts";

import { SubscriberRegistry } from "./subscriptions.js";

const config = {
  highWatermark: 1,
  lowWatermark: 0,
  stallTimeoutMs: 5
};

function makeFrame(
  id: string,
  status: Frame["status"],
  parent_id = "req-1"
): Frame {
  return {
    id,
    parent_id,
    created_ms: 1,
    expires_in: 0,
    call: "echo:ping",
    status,
    data: {}
  };
}

test("subscriber registry delivers frames to subscribers", async () => {
  const registry = new SubscriberRegistry();
  const subscriber = registry.subscribe(config);

  await registry.deliver(makeFrame("item-1", "item"));
  await registry.deliver(makeFrame("done-1", "done"));

  const first = await subscriber.recv();
  const second = await subscriber.recv();

  assert.equal(first?.status, "item");
  assert.equal(second?.status, "done");
});

test("subscriber registry evicts stalled subscribers on non-terminal backpressure", async () => {
  const registry = new SubscriberRegistry();
  const subscriber = registry.subscribe(config);

  await registry.deliver(makeFrame("item-1", "item"));
  await registry.deliver(makeFrame("item-2", "item"));

  const first = await subscriber.recv();
  const second = await subscriber.recv();

  assert.equal(first?.id, "item-1");
  assert.equal(second, undefined);
});

test("terminal frames bypass non-terminal backpressure stalling", async () => {
  const registry = new SubscriberRegistry();
  const subscriber = registry.subscribe(config);

  await registry.deliver(makeFrame("item-1", "item"));
  await registry.deliver(makeFrame("done-1", "done"));

  const frames = await subscriber.collect({
    until: (frame) => frame.status === "done"
  });

  assert.deepEqual(
    frames.map((frame) => frame.status),
    ["item", "done"]
  );
});
