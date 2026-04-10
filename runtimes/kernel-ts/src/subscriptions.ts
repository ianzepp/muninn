/**
 * SubscriberRegistry — fan-out delivery with per-subscriber backpressure.
 *
 * The kernel holds a single `SubscriberRegistry`. Every call to
 * `Kernel.subscribe()` creates a new `Subscriber` backed by a fresh
 * `AsyncQueue<Frame>` and registers it here. On each `deliver()` call the
 * registry pushes the frame to every active subscriber, applying
 * high/low-watermark flow control before each push.
 *
 * A subscriber that cannot drain its queue within `stallTimeoutMs` is evicted:
 * its queue is closed (unblocking any pending consumer) and it is removed from
 * the active set. This prevents a single slow consumer from stalling the
 * entire kernel's response path.
 *
 * TRADE-OFFS:
 * Delivery is sequential across subscribers — one stalled consumer can delay
 * delivery to the next until its stall timeout fires. This keeps the
 * implementation simple and avoids unbounded concurrency. In practice the
 * default 5-second timeout means a severely slow consumer only affects
 * in-flight frames for that window.
 */

import type { Frame } from "muninn-frames-ts";
import { isTerminalStatus } from "muninn-frames-ts";

import { AsyncQueue } from "./queue.js";
import { Subscriber } from "./subscriber.js";
import type { BackpressureConfig } from "./types.js";

interface SubscriberEntry {
  queue: AsyncQueue<Frame>;
  config: BackpressureConfig;
}

/**
 * Manages the set of active `Subscriber` instances and fans out each delivered
 * frame to all of them.
 *
 * Not exposed directly in the public API — callers interact with it through
 * `Kernel.subscribe()` and the returned `Subscriber` handle.
 */
export class SubscriberRegistry {
  private readonly subscribers = new Set<SubscriberEntry>();

  /**
   * Creates a new `Subscriber` with its own buffered queue and registers it
   * for delivery. The provided `config` controls its backpressure thresholds.
   *
   * @param config - High/low watermarks and stall timeout for the new subscriber.
   */
  subscribe(config: BackpressureConfig): Subscriber {
    const queue = new AsyncQueue<Frame>();
    this.subscribers.add({ queue, config });
    return new Subscriber(queue);
  }

  /**
   * Delivers `frame` to every registered subscriber, applying backpressure
   * before each push. Evicts subscribers that exceed their stall timeout.
   *
   * Terminal frames (done, error, cancel) bypass the high-watermark check and
   * are pushed immediately — a terminal must always reach the consumer so the
   * stream can be properly closed.
   *
   * @param frame - The frame to broadcast.
   */
  async deliver(frame: Frame): Promise<void> {
    for (const subscriber of [...this.subscribers]) {
      const delivered = await deliverToSubscriber(subscriber, frame);
      if (!delivered) {
        subscriber.queue.close();
        this.subscribers.delete(subscriber);
      }
    }
  }
}

/**
 * Attempts to deliver a single frame to one subscriber, honouring backpressure.
 *
 * Non-terminal frames trigger a drain wait when the queue is at or above the
 * high-watermark. Terminal frames are always pushed immediately because they
 * must not be lost even under heavy load.
 *
 * @returns `true` if the frame was delivered; `false` if the subscriber stalled
 *   and should be evicted.
 */
async function deliverToSubscriber(
  subscriber: SubscriberEntry,
  frame: Frame
): Promise<boolean> {
  if (!isTerminalStatus(frame.status) && subscriber.queue.size >= subscriber.config.highWatermark) {
    const drained = await subscriber.queue.waitForBelow(
      subscriber.config.lowWatermark,
      subscriber.config.stallTimeoutMs
    );
    if (!drained) {
      return false;
    }
  }

  subscriber.queue.push(frame);
  return true;
}
