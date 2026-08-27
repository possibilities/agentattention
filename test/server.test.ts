import { afterEach, describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config.ts";
import { hashToken } from "../src/ids.ts";
import { createHttpHandler } from "../src/server.ts";
import { AttentionStore } from "../src/store.ts";

const TOKEN = "aat_test-token";
const PRINCIPAL = "cred_test";
const stores: AttentionStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("HTTP API", () => {
  test("authenticates, creates, claims, resolves, and supports conditional polling", async () => {
    const { handler } = service();
    const unauthenticated = await handler(new Request("http://local/v1/items"));
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toBe("Bearer");

    const create = await api(handler, "/v1/items", {
      method: "POST",
      idempotencyKey: "http-create",
      body: {
        contract: "com.example.cover-letter-review/v3",
        title: "Review Acme cover letter",
        payload: { draft: "Dear Acme", choices: ["approve", "comment"] },
        correlationId: "application-acme",
      },
    });
    expect(create.status).toBe(201);
    const createdBody = await create.json();
    const item = createdBody.item;
    expect(item.payload.draft).toBe("Dear Acme");

    const claim = await api(handler, `/v1/items/${item.id}/claim`, {
      method: "POST",
      body: { leaseSeconds: 120 },
    });
    const claimed = (await claim.json()).item;
    expect(claimed.claim.holder).toBe(PRINCIPAL);

    const resolve = await api(handler, `/v1/items/${item.id}/resolution`, {
      method: "POST",
      idempotencyKey: "http-resolve",
      body: { claimId: claimed.claim.id, resolution: { action: "comment", text: "Shorter." } },
    });
    expect(resolve.status).toBe(200);
    const resolved = (await resolve.json()).item;
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution.payload).toEqual({ action: "comment", text: "Shorter." });

    const poll = await api(handler, `/v1/items/${item.id}`, {
      headers: { "If-None-Match": resolve.headers.get("etag") ?? "" },
    });
    expect(poll.status).toBe(304);
  });

  test("replays events and starts a resumable SSE feed", async () => {
    const { handler } = service();
    await api(handler, "/v1/items", {
      method: "POST",
      idempotencyKey: "event-create",
      body: { contract: "com.example.question/v1", title: "Question", payload: { prompt: "Why?" } },
    });

    const replay = await api(handler, "/v1/events?after=0");
    const replayBody = await replay.json();
    expect(replayBody.events).toHaveLength(1);
    expect(replayBody.events[0].kind).toBe("item.created");

    const stream = await api(handler, `/v1/events/stream?after=${replayBody.nextCursor}`);
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    const reader = stream.body?.getReader();
    expect(reader).toBeDefined();
    await api(handler, "/v1/items", {
      method: "POST",
      idempotencyKey: "event-create-live",
      body: { contract: "com.example.question/v1", title: "Live", payload: { prompt: "Now?" } },
    });
    let text = "";
    for (let index = 0; index < 3 && !text.includes("event: item.created"); index += 1) {
      const chunk = await reader?.read();
      text += new TextDecoder().decode(chunk?.value);
    }
    expect(text).toContain("id: 2");
    expect(text).toContain("event: item.created");
    await reader?.cancel();
  });

  test("resolves an unclaimed item directly and enforces credential scopes", async () => {
    const { handler } = service();
    const create = await api(handler, "/v1/items", {
      method: "POST",
      idempotencyKey: "direct-http-create",
      body: { contract: "com.example.direct/v1", title: "Direct", payload: true },
    });
    const id = (await create.json()).item.id;
    const resolution = await api(handler, `/v1/items/${id}/resolution`, {
      method: "POST",
      idempotencyKey: "direct-http-resolve",
      body: { resolution: ["opaque", 42] },
    });
    expect(resolution.status).toBe(200);
    expect((await resolution.json()).item.resolution.payload).toEqual(["opaque", 42]);

    const readOnly = service(["items:read"]).handler;
    const forbidden = await api(readOnly, "/v1/items", {
      method: "POST",
      idempotencyKey: "forbidden-create",
      body: { contract: "example/v1", title: "No", payload: null },
    });
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).code).toBe("forbidden");
  });

  test("returns problem details for invalid envelopes and idempotency reuse", async () => {
    const { handler } = service();
    const invalid = await api(handler, "/v1/items", {
      method: "POST",
      idempotencyKey: "bad-item",
      body: { contract: "example/v1", title: "Missing payload" },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("content-type")).toContain("application/problem+json");
    expect((await invalid.json()).code).toBe("invalid_item");

    await api(handler, "/v1/items", {
      method: "POST",
      idempotencyKey: "same-key",
      body: { contract: "example/v1", title: "First", payload: null },
    });
    const conflict = await api(handler, "/v1/items", {
      method: "POST",
      idempotencyKey: "same-key",
      body: { contract: "example/v1", title: "Second", payload: null },
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe("idempotency_conflict");
  });
});

function service(scopes: string[] = ["admin"]): {
  handler: (request: Request) => Promise<Response>;
  store: AttentionStore;
} {
  const store = new AttentionStore(":memory:");
  stores.push(store);
  const config: AppConfig = {
    server: { host: "127.0.0.1", port: 7331, maxBodyBytes: 1_048_576 },
    database: ":memory:",
    credentials: [
      {
        id: PRINCIPAL,
        name: "test principal",
        tokenHash: hashToken(TOKEN),
        scopes,
      },
    ],
  };
  return { store, handler: createHttpHandler({ store, config }) };
}

async function api(
  handler: (request: Request) => Promise<Response>,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    idempotencyKey?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers = new Headers({ Authorization: `Bearer ${TOKEN}`, ...options.headers });
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
  return handler(
    new Request(`http://local${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    }),
  );
}
