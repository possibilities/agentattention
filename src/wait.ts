import type { AttentionClient } from "./client.ts";
import type { AttentionEvent, AttentionItem } from "./domain.ts";
import { ServiceError } from "./errors.ts";

export type WaitMode = "any" | "all";
export type WaitReason = "terminal" | "timeout";

export interface WaitResult {
  reason: WaitReason;
  mode: WaitMode;
  cursor: number;
  terminalItems: AttentionItem[];
  items: AttentionItem[];
}

export interface WaitOptions {
  mode?: WaitMode;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type WaitClient = Pick<AttentionClient, "latestEventCursor" | "getItem" | "streamEvents">;

const TERMINAL_EVENT_KINDS = new Set([
  "item.resolved",
  "item.returned",
  "item.cancelled",
  "item.expired",
]);

export function isTerminalItem(item: AttentionItem): boolean {
  return item.status !== "open";
}

/**
 * Capture the durable cursor before the item snapshot, then consume a replaying
 * stream from that cursor. A transition can happen on either side of the
 * snapshot without being missed.
 */
export async function waitForAttention(
  client: WaitClient,
  itemIds: readonly string[],
  options: WaitOptions = {},
): Promise<WaitResult> {
  const ids = [...new Set(itemIds)];
  if (ids.length === 0) throw new TypeError("wait requires at least one attention item id");
  const mode = options.mode ?? "any";
  const timeoutMs = options.timeoutMs;
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647)
  ) {
    throw new RangeError("wait timeout must be an integer from 0 to 2147483647 milliseconds");
  }

  let cursor = await client.latestEventCursor(options.signal);
  let items = await snapshot(client, ids, options.signal);
  if (conditionMet(items, mode)) return result("terminal", mode, cursor, items);
  if (timeoutMs === 0) return result("timeout", mode, cursor, items);

  const timeoutController = new AbortController();
  const timeout =
    timeoutMs === undefined
      ? undefined
      : setTimeout(
          () => timeoutController.abort(new DOMException("wait timed out", "TimeoutError")),
          timeoutMs,
        );
  timeout?.unref?.();
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    while (!signal.aborted) {
      try {
        for await (const event of client.streamEvents({ after: cursor }, signal)) {
          cursor = Math.max(cursor, event.cursor);
          if (!ids.includes(event.itemId) || !TERMINAL_EVENT_KINDS.has(event.kind)) continue;
          items = await snapshot(client, ids, signal);
          if (conditionMet(items, mode)) return result("terminal", mode, cursor, items);
        }
        if (!signal.aborted) await reconnectDelay(signal);
      } catch (error) {
        if (signal.aborted) break;
        if (!retryableWaitError(error)) throw error;
        await reconnectDelay(signal);
      }
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }

  if (options.signal?.aborted) options.signal.throwIfAborted();
  items = await snapshot(client, ids);
  if (conditionMet(items, mode)) return result("terminal", mode, cursor, items);
  return result("timeout", mode, cursor, items);
}

function conditionMet(items: readonly AttentionItem[], mode: WaitMode): boolean {
  return mode === "all" ? items.every(isTerminalItem) : items.some(isTerminalItem);
}

function result(
  reason: WaitReason,
  mode: WaitMode,
  cursor: number,
  items: AttentionItem[],
): WaitResult {
  return {
    reason,
    mode,
    cursor,
    terminalItems: items.filter(isTerminalItem),
    items,
  };
}

async function snapshot(
  client: Pick<AttentionClient, "getItem">,
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<AttentionItem[]> {
  return await Promise.all(ids.map((id) => client.getItem(id, signal)));
}

async function reconnectDelay(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", aborted);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, 250);
    const aborted = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

function retryableWaitError(error: unknown): boolean {
  if (!(error instanceof ServiceError)) return true;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

export function terminalEvent(event: AttentionEvent): boolean {
  return TERMINAL_EVENT_KINDS.has(event.kind);
}
