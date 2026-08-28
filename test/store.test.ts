import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
      context: "The release train is waiting on this choice.",
      payload: { unexpected: [1, true, null, { nested: "untouched" }] },
      labels: { project: "orbiter" },
    };
    const created = store.createItem(input, "producer", "create-1");
    const replay = store.createItem(input, "producer", "create-1");

    expect(replay).toEqual(created);
    expect(created.payload).toEqual(input.payload);
    expect(created.context).toBe(input.context);
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

  test("returns an item with a mechanical reason and optional producer context", () => {
    const store = memoryStore();
    const item = store.createItem(
      {
        contract: "example.browser-interaction/v1",
        title: "Sign in",
        context: "Use the account selected for this search.",
        payload: { targetName: "research" },
      },
      "producer",
      "return-create",
    );
    const claimed = store.claimItem(item.id, "handler", 300);
    const returned = store.returnItem(
      item.id,
      claimed.claim?.id ?? "",
      "stale",
      "The page no longer shows the sign-in form.",
      "handler",
      "return-item",
    );

    expect(returned.status).toBe("returned");
    expect(returned.returnOutcome).toEqual({
      reason: "stale",
      comment: "The page no longer shows the sign-in form.",
      returnedBy: "handler",
      returnedAt: expect.any(String),
    });
    expect(returned.claim).toBeNull();
    expect(
      store.returnItem(
        item.id,
        claimed.claim?.id ?? "",
        "stale",
        "The page no longer shows the sign-in form.",
        "handler",
        "return-item",
      ),
    ).toEqual(returned);
    expect(store.listEvents({ after: 0, limit: 100 }).events.map((event) => event.kind)).toEqual([
      "item.created",
      "item.claimed",
      "item.returned",
    ]);
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
        useBefore: "2026-08-27T12:00:08.000Z",
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

  test("migrates a schema-v1 database without losing items or related records", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "agentattention-migration-"));
    directories.push(directory);
    const path = resolve(directory, "attention.sqlite3");
    const fixture = new Database(path, { create: true, strict: true });
    fixture.exec(readFileSync(resolve(import.meta.dir, "../migrations/0001_initial.sql"), "utf8"));
    fixture
      .query(
        `INSERT INTO attention_items
          (id, contract, title, payload_json, priority, labels_json, correlation_id, parent_id,
           status, created_by, created_at, updated_at, expires_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "attn_v1",
        "example.migrated/v1",
        "Preserve me",
        JSON.stringify({ from: "v1" }),
        7,
        JSON.stringify({ project: "migration" }),
        "round-v1",
        null,
        "open",
        "producer",
        "2026-08-28T12:00:00.000Z",
        "2026-08-28T12:00:00.000Z",
        "2099-01-01T00:00:00.000Z",
        2,
      );
    fixture
      .query(
        `INSERT INTO claims(item_id, claim_id, holder_id, claimed_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "attn_v1",
        "claim_v1",
        "handler",
        "2026-08-28T12:00:00.000Z",
        "2099-01-01T00:00:00.000Z",
      );
    fixture
      .query(
        `INSERT INTO events(item_id, item_revision, kind, actor_id, data_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "attn_v1",
        2,
        "item.claimed",
        "handler",
        JSON.stringify({ claimId: "claim_v1" }),
        "2026-08-28T12:00:00.000Z",
      );
    fixture
      .query(
        `INSERT INTO idempotency
          (principal_id, operation, idempotency_key, request_hash, item_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "producer",
        "create",
        "v1-create",
        "fixture-hash",
        "attn_v1",
        "2026-08-28T12:00:00.000Z",
      );
    fixture.close();

    const migrated = new AttentionStore(path, {
      now: () => new Date("2026-08-28T13:00:00.000Z"),
    });
    stores.push(migrated);
    const item = migrated.getItem("attn_v1");
    expect(item).toMatchObject({
      title: "Preserve me",
      context: null,
      payload: { from: "v1" },
      labels: { project: "migration" },
      useBefore: "2099-01-01T00:00:00.000Z",
      claim: { id: "claim_v1", holder: "handler" },
    });
    expect(migrated.latestEventCursor()).toBe(1);
    expect(
      migrated.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
    ).toBe(2);
    expect(migrated.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(migrated.releaseClaim("attn_v1", "claim_v1", "handler").claim).toBeNull();
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
