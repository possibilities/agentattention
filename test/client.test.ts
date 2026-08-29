import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { AttentionClient } from "../src/client.ts";
import {
  type AppConfig,
  type ClientConfig,
  createInitialConfig,
  createOrRotateLocalClient,
  loadClientConfig,
  loadConfig,
  saveClientConfig,
  saveConfig,
} from "../src/config.ts";
import { ServiceError } from "../src/errors.ts";
import { hashToken } from "../src/ids.ts";
import { createHttpHandler } from "../src/server.ts";
import { AttentionStore } from "../src/store.ts";

const directories: string[] = [];
const stores: AttentionStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("client configuration", () => {
  test("creates separate administrator and mode-0600 local client credentials", () => {
    const directory = temporaryDirectory("agentattention-config-");
    const serverPath = resolve(directory, "private", "config.json");
    const clientPath = resolve(directory, "private", "client.json");
    const created = createInitialConfig();
    created.config.database = resolve(directory, "attention.sqlite3");

    saveConfig(serverPath, created.config);
    saveClientConfig(clientPath, created.client);

    expect(statSync(dirname(serverPath)).mode & 0o777).toBe(0o700);
    expect(statSync(serverPath).mode & 0o777).toBe(0o600);
    expect(statSync(clientPath).mode & 0o777).toBe(0o600);
    expect(loadConfig(serverPath)).toEqual(created.config);
    expect(loadClientConfig(clientPath)).toEqual(created.client);
    expect(created.client.token).not.toBe(created.administratorToken);
    expect(created.config.credentials[1]?.scopes).toContain("items:return");
    expect(readFileSync(clientPath, "utf8")).not.toContain(created.administratorToken);
  });

  test("repairs restrictive permissions when atomically replacing existing configs", () => {
    const directory = temporaryDirectory("agentattention-permissions-");
    const path = resolve(directory, "client.json");
    const created = createInitialConfig();
    saveClientConfig(path, created.client);
    chmodSync(path, 0o644);
    saveClientConfig(path, created.client);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("refuses ambiguous or nonstandard local-client principals", () => {
    const created = createInitialConfig();
    const local = created.config.credentials.find((entry) => entry.name === "local client");
    if (!local) throw new Error("initial config omitted local client");

    try {
      createOrRotateLocalClient({
        ...created.config,
        credentials: [...created.config.credentials, { ...local, id: "cred_duplicate" }],
      });
      throw new Error("expected duplicate local clients to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceError);
      expect((error as ServiceError).code).toBe("ambiguous_local_client");
    }

    try {
      createOrRotateLocalClient({
        ...created.config,
        credentials: created.config.credentials.map((entry) =>
          entry.id === local.id ? { ...entry, scopes: ["items:read"] } : entry,
        ),
      });
      throw new Error("expected nonstandard local-client scopes to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceError);
      expect((error as ServiceError).code).toBe("local_client_scope_mismatch");
    }
  });
});

describe("AttentionClient", () => {
  test("drives lifecycle requests and parses the resumable event stream", async () => {
    const { client } = serviceClient();
    const created = await client.createItem(
      {
        contract: "example.client/v1",
        title: "Client item",
        context: "Created through the typed client.",
        payload: { action: "answer" },
        labels: { project: "client-test" },
      },
      "client-create",
    );
    expect((await client.listItems({ labels: { project: "client-test" } })).items).toHaveLength(1);
    const cursor = await client.latestEventCursor();
    const nextEvent = client.streamEvents({ after: cursor }).next();
    const second = await client.createItem(
      { contract: "example.client/v1", title: "Streamed", payload: null },
      "client-stream",
    );
    expect((await nextEvent).value).toMatchObject({ itemId: second.id, kind: "item.created" });

    const claimed = await client.claimItem(created.id, 120);
    const returned = await client.returnItem(created.id, "stale", {
      claimId: claimed.claim?.id ?? null,
      comment: "The originating page changed.",
      idempotencyKey: "client-return",
    });
    expect(returned).toMatchObject({
      status: "returned",
      returnOutcome: { reason: "stale", comment: "The originating page changed." },
    });
  });

  test("turns problem details into typed service errors", async () => {
    const { client } = serviceClient();
    try {
      await client.getItem("attn_missing");
      throw new Error("expected getItem to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceError);
      expect((error as ServiceError).code).toBe("not_found");
      expect((error as ServiceError).status).toBe(404);
    }
  });
});

function serviceClient(): { client: AttentionClient; store: AttentionStore } {
  const token = "aat_client-test";
  const store = new AttentionStore(":memory:");
  stores.push(store);
  const config: AppConfig = {
    server: { host: "127.0.0.1", port: 7331, maxBodyBytes: 1_048_576 },
    database: ":memory:",
    credentials: [
      {
        id: "cred_client",
        name: "client test",
        tokenHash: hashToken(token),
        scopes: ["admin"],
      },
    ],
  };
  const handler = createHttpHandler({ store, config });
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) =>
    handler(new Request(input, init))) as typeof fetch;
  const clientConfig: ClientConfig = {
    version: 1,
    url: "http://127.0.0.1:7331",
    token,
    principal: { id: "cred_client", name: "client test" },
  };
  return { client: new AttentionClient(clientConfig, fetcher), store };
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(resolve(tmpdir(), prefix));
  directories.push(directory);
  chmodSync(directory, 0o700);
  return directory;
}
