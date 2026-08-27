import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ServiceError } from "../src/errors.ts";
import { AttentionStore } from "../src/store.ts";

const stores: AttentionStore[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("AttentionStore", () => {
  test("preserves opaque payloads and makes creation idempotent", () => {
    const store = memoryStore();
    const input = {
      contract: "example.question/v7",
      title: "Choose a deployment",
      payload: { unexpected: [1, true, null, { nested: "untouched" }] },
      labels: { project: "orbiter" },
    };
    const created = store.createItem(input, "producer", "create-1");
    const replay = store.createItem(input, "producer", "create-1");

    expect(replay).toEqual(created);
    expect(created.payload).toEqual(input.payload);
    expect(store.listEvents({ after: 0, limit: 100 }).events.map((event) => event.kind)).toEqual([
      "item.created",
    ]);

    expectServiceError(
      () => store.createItem({ ...input, title: "Different" }, "producer", "create-1"),
      "idempotency_conflict",
    );
  });

  test("commits independently of in-process event subscribers", () => {
    const store = memoryStore();
    store.subscribe(() => {
      throw new Error("broken listener");
    });
    const originalError = console.error;
    console.error = () => {};
    try {
      const item = store.createItem(
        { contract: "example.listener/v1", title: "Still commits", payload: null },
        "producer",
        "listener-1",
      );
      expect(store.getItem(item.id).title).toBe("Still commits");
    } finally {
      console.error = originalError;
    }
  });

  test("claims exclusively and resolves exactly once", () => {
    const store = memoryStore();
    const item = store.createItem(
      { contract: "example.approval/v1", title: "Approve", payload: { draft: "hello" } },
      "producer",
      "create-2",
    );
    const claimed = store.claimItem(item.id, "handler-a", 300);
    expect(claimed.claim?.holder).toBe("handler-a");
    expect(store.claimItem(item.id, "handler-a", 300)).toEqual(claimed);
    expectServiceError(() => store.claimItem(item.id, "handler-b", 300), "already_claimed");

    const resolution = { disposition: "comment", comment: "Tighten the opening." };
    const resolved = store.resolveItem(
      item.id,
      claimed.claim?.id ?? "",
      resolution,
      "handler-a",
      "resolve-1",
    );
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution?.payload).toEqual(resolution);
    expect(resolved.claim).toBeNull();
    expect(
      store.resolveItem(item.id, claimed.claim?.id ?? "", resolution, "handler-a", "resolve-1"),
    ).toEqual(resolved);
    expectServiceError(
      () => store.resolveItem(item.id, claimed.claim?.id ?? "", null, "handler-a", "resolve-2"),
      "item_not_open",
    );

    expect(store.listEvents({ after: 0, limit: 100 }).events.map((event) => event.kind)).toEqual([
      "item.created",
      "item.claimed",
      "item.resolved",
    ]);
  });

  test("resolves an unclaimed item atomically without interpreting the resolution", () => {
    const store = memoryStore();
    const item = store.createItem(
      { contract: "example.direct/v1", title: "Direct", payload: ["anything"] },
      "producer",
      "direct-create",
    );
    const resolved = store.resolveItem(
      item.id,
      null,
      ["also", { anything: true }],
      "handler",
      "direct-resolve",
    );
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution?.payload).toEqual(["also", { anything: true }]);
  });

  test("expires claims and items using durable events", () => {
    let current = new Date("2026-08-27T12:00:00.000Z");
    const store = memoryStore(() => current);
    const claimedItem = store.createItem(
      { contract: "example.captcha/v1", title: "Captcha", payload: {} },
      "producer",
      "expiry-claim",
    );
    store.claimItem(claimedItem.id, "handler", 5);
    const expiringItem = store.createItem(
      {
        contract: "example.question/v1",
        title: "Short lived",
        payload: null,
        expiresAt: "2026-08-27T12:00:08.000Z",
      },
      "producer",
      "expiry-item",
    );

    current = new Date("2026-08-27T12:00:06.000Z");
    expect(store.sweepExpired()).toBe(1);
    expect(store.getItem(claimedItem.id).claim).toBeNull();
    current = new Date("2026-08-27T12:00:09.000Z");
    expect(store.sweepExpired()).toBe(1);
    expect(store.getItem(expiringItem.id).status).toBe("expired");

    expect(store.listEvents({ after: 0, limit: 100 }).events.map((event) => event.kind)).toContain(
      "item.claim.expired",
    );
    expect(store.listEvents({ after: 0, limit: 100 }).events.map((event) => event.kind)).toContain(
      "item.expired",
    );
  });

  test("renews, releases, and cancels claims with explicit events", () => {
    const store = memoryStore();
    const item = store.createItem(
      { contract: "example.claims/v1", title: "Claim lifecycle", payload: {} },
      "producer",
      "claims-create",
    );
    const claimed = store.claimItem(item.id, "handler", 60);
    const renewed = store.renewClaim(item.id, claimed.claim?.id ?? "", "handler", 120);
    expect(renewed.claim?.expiresAt).not.toBe(claimed.claim?.expiresAt);
    const released = store.releaseClaim(item.id, renewed.claim?.id ?? "", "handler");
    expect(released.claim).toBeNull();
    store.claimItem(item.id, "handler", 60);
    const cancelled = store.cancelItem(item.id, "No longer needed", "producer", "claims-cancel");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.claim).toBeNull();
    expect(cancelled.cancellation?.reason).toBe("No longer needed");
    expect(store.cancelItem(item.id, "No longer needed", "producer", "claims-cancel")).toEqual(
      cancelled,
    );
    expect(store.listEvents({ after: 0, limit: 100 }).events.map((event) => event.kind)).toEqual([
      "item.created",
      "item.claimed",
      "item.claim.renewed",
      "item.claim.released",
      "item.claimed",
      "item.cancelled",
    ]);
  });

  test("paginates stable priority order and filters labels", () => {
    const store = memoryStore();
    store.createItem(
      {
        contract: "example/v1",
        title: "Low",
        payload: {},
        priority: 1,
        labels: { lane: "manual" },
      },
      "producer",
      "page-1",
    );
    store.createItem(
      {
        contract: "example/v1",
        title: "High",
        payload: {},
        priority: 10,
        labels: { lane: "manual" },
      },
      "producer",
      "page-2",
    );
    store.createItem(
      {
        contract: "example/v1",
        title: "Other",
        payload: {},
        priority: 5,
        labels: { lane: "agent" },
      },
      "producer",
      "page-3",
    );
    const first = store.listItems({ limit: 1, status: "open", labels: { lane: "manual" } });
    expect(first.items.map((item) => item.title)).toEqual(["High"]);
    expect(first.nextCursor).not.toBeNull();
    const second = store.listItems({
      limit: 1,
      status: "open",
      labels: { lane: "manual" },
      cursor: first.nextCursor as string,
    });
    expect(second.items.map((item) => item.title)).toEqual(["Low"]);
    expect(second.nextCursor).toBeNull();
  });

  test("survives close and reopen", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "agentattention-store-"));
    directories.push(directory);
    const path = resolve(directory, "attention.sqlite3");
    const first = new AttentionStore(path);
    const created = first.createItem(
      { contract: "example.persist/v1", title: "Persist me", payload: { durable: true } },
      "producer",
      "durable-1",
    );
    first.close();
    const second = new AttentionStore(path);
    stores.push(second);
    expect(second.getItem(created.id).payload).toEqual({ durable: true });
    expect(second.latestEventCursor()).toBe(1);
  });
});

function memoryStore(now?: () => Date): AttentionStore {
  const store = new AttentionStore(":memory:", now ? { now } : {});
  stores.push(store);
  return store;
}

function expectServiceError(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error("Expected operation to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe(code);
  }
}
