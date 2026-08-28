import { describe, expect, test } from "bun:test";
import type { AttentionEvent, AttentionItem } from "../src/domain.ts";
import { ServiceError } from "../src/errors.ts";
import { type WaitClient, waitForAttention } from "../src/wait.ts";

describe("waitForAttention", () => {
  test("returns immediately when the pre-stream snapshot is already terminal", async () => {
    let streamed = false;
    const client: WaitClient = {
      latestEventCursor: async () => 7,
      getItem: async (id) => item(id, "resolved"),
      streamEvents: () => {
        streamed = true;
        return noEvents();
      },
    };

    const result = await waitForAttention(client, ["attn_one"]);
    expect(result).toMatchObject({ reason: "terminal", mode: "any", cursor: 7 });
    expect(result.terminalItems.map((entry) => entry.id)).toEqual(["attn_one"]);
    expect(streamed).toBe(false);
  });

  test("replays a transition that happened after the captured cursor", async () => {
    let terminal = false;
    const client: WaitClient = {
      latestEventCursor: async () => 10,
      getItem: async (id) => item(id, terminal ? "returned" : "open"),
      streamEvents: async function* () {
        terminal = true;
        yield event(11, "attn_one", "item.returned");
      },
    };

    const result = await waitForAttention(client, ["attn_one"]);
    expect(result.reason).toBe("terminal");
    expect(result.cursor).toBe(11);
    expect(result.items[0]?.status).toBe("returned");
  });

  test("supports waiting until every watched item is terminal", async () => {
    const statuses = new Map<string, AttentionItem["status"]>([
      ["attn_one", "resolved"],
      ["attn_two", "open"],
    ]);
    const client: WaitClient = {
      latestEventCursor: async () => 2,
      getItem: async (id) => item(id, statuses.get(id) ?? "open"),
      streamEvents: async function* () {
        statuses.set("attn_two", "expired");
        yield event(3, "attn_two", "item.expired");
      },
    };

    const result = await waitForAttention(client, ["attn_one", "attn_two"], { mode: "all" });
    expect(result.reason).toBe("terminal");
    expect(result.terminalItems).toHaveLength(2);
  });

  test("returns a structured timeout without opening a stream for zero duration", async () => {
    const client: WaitClient = {
      latestEventCursor: async () => 0,
      getItem: async (id) => item(id, "open"),
      streamEvents: () => {
        throw new Error("should not stream");
      },
    };

    const result = await waitForAttention(client, ["attn_one"], { timeoutMs: 0 });
    expect(result).toMatchObject({ reason: "timeout", mode: "any", cursor: 0 });
    expect(result.terminalItems).toEqual([]);
  });

  test("delays reconnecting after a normally closed event stream", async () => {
    let streamCount = 0;
    const client: WaitClient = {
      latestEventCursor: async () => 0,
      getItem: async (id) => item(id, "open"),
      streamEvents: () => {
        streamCount += 1;
        return noEvents();
      },
    };

    const result = await waitForAttention(client, ["attn_one"], { timeoutMs: 20 });
    expect(result.reason).toBe("timeout");
    expect(streamCount).toBe(1);
  });

  test("surfaces non-retryable service errors", async () => {
    const client: WaitClient = {
      latestEventCursor: async () => 0,
      getItem: async (id) => item(id, "open"),
      streamEvents: async function* () {
        const attentionEvent = await Promise.reject<AttentionEvent>(
          new ServiceError("unauthorized", 401, "Credential expired"),
        );
        yield attentionEvent;
      },
    };

    await expect(waitForAttention(client, ["attn_one"])).rejects.toMatchObject({
      code: "unauthorized",
      status: 401,
    });
  });
});

async function* noEvents(): AsyncGenerator<AttentionEvent, void, void> {
  for (const attentionEvent of [] as AttentionEvent[]) yield attentionEvent;
}

function item(id: string, status: AttentionItem["status"]): AttentionItem {
  return {
    id,
    contract: "example/v1",
    title: id,
    context: null,
    payload: null,
    priority: 0,
    labels: {},
    correlationId: null,
    parentId: null,
    status,
    claim: null,
    resolution:
      status === "resolved"
        ? { payload: null, resolvedBy: "handler", resolvedAt: "2026-08-28T00:00:00.000Z" }
        : null,
    returnOutcome:
      status === "returned"
        ? {
            reason: "stale",
            comment: null,
            returnedBy: "handler",
            returnedAt: "2026-08-28T00:00:00.000Z",
          }
        : null,
    cancellation: null,
    createdBy: "producer",
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    useBefore: null,
    revision: status === "open" ? 1 : 2,
  };
}

function event(cursor: number, itemId: string, kind: string): AttentionEvent {
  return {
    cursor,
    itemId,
    itemRevision: 2,
    contract: "example/v1",
    correlationId: null,
    kind,
    actor: "handler",
    data: {},
    occurredAt: "2026-08-28T00:00:00.000Z",
  };
}
