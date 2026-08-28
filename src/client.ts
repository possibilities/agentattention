import type { ClientConfig } from "./config.ts";
import type {
  AttentionEvent,
  AttentionItem,
  AttentionStatus,
  CreateItemInput,
  JsonValue,
} from "./domain.ts";
import { ServiceError } from "./errors.ts";
import type { EventPage, ItemPage } from "./store.ts";

export interface ListItemOptions {
  status?: AttentionStatus;
  contract?: string;
  correlationId?: string;
  labels?: Record<string, string>;
  claimed?: "any" | "claimed" | "unclaimed" | "mine";
  cursor?: string;
  limit?: number;
}

export interface ListEventOptions {
  after?: number;
  limit?: number;
  itemId?: string;
  contract?: string;
  correlationId?: string;
}

export class AttentionClient {
  constructor(
    readonly config: ClientConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async latestEventCursor(signal?: AbortSignal): Promise<number> {
    const response = await this.request<{ eventCursor: number }>(
      "/readyz",
      { signal: signal ?? null },
      false,
    );
    return response.eventCursor;
  }

  async createItem(
    input: CreateItemInput,
    idempotencyKey: string = crypto.randomUUID(),
    signal?: AbortSignal,
  ): Promise<AttentionItem> {
    return (
      await this.request<{ item: AttentionItem }>("/v1/items", {
        method: "POST",
        body: JSON.stringify(input),
        headers: jsonHeaders(idempotencyKey),
        signal: signal ?? null,
      })
    ).item;
  }

  async getItem(id: string, signal?: AbortSignal): Promise<AttentionItem> {
    return (
      await this.request<{ item: AttentionItem }>(`/v1/items/${encodeURIComponent(id)}`, {
        signal: signal ?? null,
      })
    ).item;
  }

  async listItems(options: ListItemOptions = {}, signal?: AbortSignal): Promise<ItemPage> {
    const query = new URLSearchParams();
    setQuery(query, "status", options.status);
    setQuery(query, "contract", options.contract);
    setQuery(query, "correlationId", options.correlationId);
    setQuery(query, "claimed", options.claimed);
    setQuery(query, "cursor", options.cursor);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    for (const [key, value] of Object.entries(options.labels ?? {})) {
      query.append("label", `${key}=${value}`);
    }
    return await this.request<ItemPage>(withQuery("/v1/items", query), {
      signal: signal ?? null,
    });
  }

  async claimItem(id: string, leaseSeconds = 300, signal?: AbortSignal): Promise<AttentionItem> {
    return (
      await this.request<{ item: AttentionItem }>(`/v1/items/${encodeURIComponent(id)}/claim`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ leaseSeconds }),
        signal: signal ?? null,
      })
    ).item;
  }

  async renewClaim(
    id: string,
    claimId: string,
    leaseSeconds = 300,
    signal?: AbortSignal,
  ): Promise<AttentionItem> {
    return (
      await this.request<{ item: AttentionItem }>(`/v1/items/${encodeURIComponent(id)}/claim`, {
        method: "PATCH",
        headers: jsonHeaders(),
        body: JSON.stringify({ claimId, leaseSeconds }),
        signal: signal ?? null,
      })
    ).item;
  }

  async releaseClaim(id: string, claimId: string, signal?: AbortSignal): Promise<AttentionItem> {
    return (
      await this.request<{ item: AttentionItem }>(`/v1/items/${encodeURIComponent(id)}/claim`, {
        method: "DELETE",
        headers: jsonHeaders(),
        body: JSON.stringify({ claimId }),
        signal: signal ?? null,
      })
    ).item;
  }

  async resolveItem(
    id: string,
    resolution: JsonValue,
    options: { claimId?: string | null; idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<AttentionItem> {
    return (
      await this.request<{ item: AttentionItem }>(
        `/v1/items/${encodeURIComponent(id)}/resolution`,
        {
          method: "POST",
          headers: jsonHeaders(options.idempotencyKey ?? crypto.randomUUID()),
          body: JSON.stringify({ claimId: options.claimId ?? null, resolution }),
          signal: options.signal ?? null,
        },
      )
    ).item;
  }

  async returnItem(
    id: string,
    reason: string,
    options: {
      claimId?: string | null;
      comment?: string | null;
      idempotencyKey?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<AttentionItem> {
    return (
      await this.request<{ item: AttentionItem }>(`/v1/items/${encodeURIComponent(id)}/return`, {
        method: "POST",
        headers: jsonHeaders(options.idempotencyKey ?? crypto.randomUUID()),
        body: JSON.stringify({
          claimId: options.claimId ?? null,
          reason,
          comment: options.comment ?? null,
        }),
        signal: options.signal ?? null,
      })
    ).item;
  }

  async cancelItem(
    id: string,
    reason: string,
    options: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<AttentionItem> {
    return (
      await this.request<{ item: AttentionItem }>(
        `/v1/items/${encodeURIComponent(id)}/cancellation`,
        {
          method: "POST",
          headers: jsonHeaders(options.idempotencyKey ?? crypto.randomUUID()),
          body: JSON.stringify({ reason }),
          signal: options.signal ?? null,
        },
      )
    ).item;
  }

  async listEvents(options: ListEventOptions = {}, signal?: AbortSignal): Promise<EventPage> {
    const query = eventQuery(options);
    return await this.request<EventPage>(withQuery("/v1/events", query), {
      signal: signal ?? null,
    });
  }

  async *streamEvents(
    options: ListEventOptions = {},
    signal?: AbortSignal,
  ): AsyncGenerator<AttentionEvent> {
    const query = eventQuery(options);
    const response = await this.fetcher(
      new URL(withQuery("/v1/events/stream", query), `${this.config.url}/`),
      {
        headers: { Authorization: `Bearer ${this.config.token}` },
        signal: signal ?? null,
      },
    );
    if (!response.ok) await throwResponseError(response);
    if (!response.body)
      throw new ServiceError("empty_event_stream", 500, "Event stream has no body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
        while (true) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary < 0) break;
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = parseEventBlock(block);
          if (event) yield event;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  private async request<T>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> {
    const headers = new Headers(init.headers);
    if (authenticated) headers.set("Authorization", `Bearer ${this.config.token}`);
    const response = await this.fetcher(new URL(path, `${this.config.url}/`), { ...init, headers });
    if (!response.ok) await throwResponseError(response);
    return (await response.json()) as T;
  }
}

function eventQuery(options: ListEventOptions): URLSearchParams {
  const query = new URLSearchParams();
  if (options.after !== undefined) query.set("after", String(options.after));
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  setQuery(query, "itemId", options.itemId);
  setQuery(query, "contract", options.contract);
  setQuery(query, "correlationId", options.correlationId);
  return query;
}

function jsonHeaders(idempotencyKey?: string): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  return headers;
}

function setQuery(query: URLSearchParams, key: string, value: string | undefined): void {
  if (value !== undefined && value !== "") query.set(key, value);
}

function withQuery(path: string, query: URLSearchParams): string {
  const suffix = query.toString();
  return suffix.length === 0 ? path : `${path}?${suffix}`;
}

function parseEventBlock(block: string): AttentionEvent | null {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (data.length === 0) return null;
  try {
    const parsed = JSON.parse(data) as AttentionEvent;
    return typeof parsed.cursor === "number" && typeof parsed.itemId === "string" ? parsed : null;
  } catch {
    throw new ServiceError("invalid_event_stream", 500, "Event stream returned invalid JSON");
  }
}

async function throwResponseError(response: Response): Promise<never> {
  let body: { code?: string; detail?: string } = {};
  try {
    body = (await response.json()) as { code?: string; detail?: string };
  } catch {
    // Fall back to the HTTP status below.
  }
  throw new ServiceError(
    body.code ?? "http_error",
    response.status,
    body.detail ?? `Agentattention returned HTTP ${response.status}`,
  );
}
