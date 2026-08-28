import { Authenticator } from "./auth.ts";
import type { AppConfig } from "./config.ts";
import type { EventFilters, ItemFilters, Principal } from "./domain.ts";
import { badRequest, notFound, ServiceError } from "./errors.ts";
import type { AttentionStore } from "./store.ts";
import {
  parseCancellation,
  parseClaim,
  parseClaimMutation,
  parseCreateItem,
  parsePositiveInteger,
  parseResolution,
  parseReturn,
  parseStatus,
  validateIdempotencyKey,
} from "./validation.ts";

export interface HttpServiceOptions {
  store: AttentionStore;
  config: AppConfig;
}

export function createHttpHandler(
  options: HttpServiceOptions,
): (request: Request) => Promise<Response> {
  const { store, config } = options;
  const auth = new Authenticator(config.credentials);

  return async (request) => {
    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz") {
        return json({ status: "ok" }, 200, requestId);
      }
      if (request.method === "GET" && url.pathname === "/readyz") {
        return json({ status: "ready", eventCursor: store.latestEventCursor() }, 200, requestId);
      }
      if (request.method === "POST" && url.pathname === "/v1/items") {
        const principal = auth.authenticate(request, "items:create");
        const body = parseCreateItem(await readJson(request, config.server.maxBodyBytes));
        const key = validateIdempotencyKey(request.headers.get("idempotency-key"));
        const item = store.createItem(body, principal.id, key);
        return itemResponse(item, 201, requestId, { Location: `/v1/items/${item.id}` });
      }
      if (request.method === "GET" && url.pathname === "/v1/items") {
        const principal = auth.authenticate(request, "items:read");
        const filters = parseItemFilters(url, principal);
        const page = store.listItems(filters);
        return json(page, 200, requestId);
      }
      if (request.method === "GET" && url.pathname === "/v1/events") {
        auth.authenticate(request, "events:read");
        const page = store.listEvents(parseEventFilters(url));
        return json(page, 200, requestId);
      }
      if (request.method === "GET" && url.pathname === "/v1/events/stream") {
        auth.authenticate(request, "events:read");
        return eventStream(request, url, store, requestId);
      }

      const match = url.pathname.match(
        /^\/v1\/items\/([^/]+)(?:\/(claim|resolution|return|cancellation))?$/,
      );
      if (match) {
        const id = decodePathSegment(match[1] ?? "");
        const operation = match[2];
        if (request.method === "GET" && operation === undefined) {
          auth.authenticate(request, "items:read");
          const item = store.getItem(id);
          const etag = itemEtag(item.revision);
          if (request.headers.get("if-none-match") === etag) {
            return new Response(null, {
              status: 304,
              headers: commonHeaders(requestId, { ETag: etag }),
            });
          }
          return itemResponse(item, 200, requestId);
        }
        if (operation === "claim") {
          const principal = auth.authenticate(request, "items:claim");
          if (request.method === "POST") {
            const { leaseSeconds } = parseClaim(
              await readJson(request, config.server.maxBodyBytes),
            );
            return itemResponse(store.claimItem(id, principal.id, leaseSeconds), 200, requestId);
          }
          if (request.method === "PATCH") {
            const body = parseClaimMutation(await readJson(request, config.server.maxBodyBytes));
            if (body.leaseSeconds === undefined) {
              throw badRequest("missing_lease", "leaseSeconds is required when renewing a claim");
            }
            return itemResponse(
              store.renewClaim(id, body.claimId, principal.id, body.leaseSeconds),
              200,
              requestId,
            );
          }
          if (request.method === "DELETE") {
            const body = parseClaimMutation(await readJson(request, config.server.maxBodyBytes));
            return itemResponse(store.releaseClaim(id, body.claimId, principal.id), 200, requestId);
          }
        }
        if (request.method === "POST" && operation === "resolution") {
          const principal = auth.authenticate(request, "items:resolve");
          const body = parseResolution(await readJson(request, config.server.maxBodyBytes));
          const key = validateIdempotencyKey(request.headers.get("idempotency-key"));
          return itemResponse(
            store.resolveItem(id, body.claimId, body.resolution, principal.id, key),
            200,
            requestId,
          );
        }
        if (request.method === "POST" && operation === "return") {
          const principal = auth.authenticate(request, "items:return");
          const body = parseReturn(await readJson(request, config.server.maxBodyBytes));
          const key = validateIdempotencyKey(request.headers.get("idempotency-key"));
          return itemResponse(
            store.returnItem(id, body.claimId, body.reason, body.comment, principal.id, key),
            200,
            requestId,
          );
        }
        if (request.method === "POST" && operation === "cancellation") {
          const principal = auth.authenticate(request, "items:cancel");
          const { reason } = parseCancellation(await readJson(request, config.server.maxBodyBytes));
          const key = validateIdempotencyKey(request.headers.get("idempotency-key"));
          return itemResponse(store.cancelItem(id, reason, principal.id, key), 200, requestId);
        }
      }
      throw notFound("Route not found");
    } catch (error) {
      return problemResponse(error, requestId);
    }
  };
}

function parseItemFilters(url: URL, principal: Principal): ItemFilters {
  const claimed = url.searchParams.get("claimed") ?? "any";
  if (!new Set(["any", "claimed", "unclaimed", "mine"]).has(claimed)) {
    throw badRequest("invalid_filter", "claimed must be any, claimed, unclaimed, or mine");
  }
  const labels: Record<string, string> = {};
  for (const filter of url.searchParams.getAll("label")) {
    const separator = filter.indexOf("=");
    if (separator <= 0) throw badRequest("invalid_filter", "label filters use key=value");
    const key = filter.slice(0, separator);
    const value = filter.slice(separator + 1);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(key) || value.length > 256) {
      throw badRequest("invalid_filter", "label filter has an invalid key or value");
    }
    labels[key] = value;
  }
  if (Object.keys(labels).length > 32)
    throw badRequest("invalid_filter", "At most 32 label filters are allowed");
  const limit = parsePositiveInteger(url.searchParams.get("limit"), "limit", 100, 500);
  if (limit < 1) throw badRequest("invalid_filter", "limit must be at least 1");
  const filters: ItemFilters = {
    limit,
    claimed: claimed as "any" | "claimed" | "unclaimed" | "mine",
    principalId: principal.id,
  };
  const status = parseStatus(url.searchParams.get("status"));
  if (status) filters.status = status;
  assignOptional(filters, "contract", url.searchParams.get("contract"));
  assignOptional(filters, "correlationId", url.searchParams.get("correlationId"));
  assignOptional(filters, "cursor", url.searchParams.get("cursor"));
  if (Object.keys(labels).length > 0) filters.labels = labels;
  return filters;
}

function parseEventFilters(url: URL, request?: Request): EventFilters {
  const queryAfter = url.searchParams.get("after");
  const headerAfter = request?.headers.get("last-event-id") ?? null;
  const filters: EventFilters = {
    after: parsePositiveInteger(queryAfter ?? headerAfter, "after", 0, Number.MAX_SAFE_INTEGER),
    limit: parsePositiveInteger(url.searchParams.get("limit"), "limit", 100, 1_000),
  };
  if (filters.limit < 1) throw badRequest("invalid_filter", "limit must be at least 1");
  assignOptional(filters, "itemId", url.searchParams.get("itemId"));
  assignOptional(filters, "contract", url.searchParams.get("contract"));
  assignOptional(filters, "correlationId", url.searchParams.get("correlationId"));
  return filters;
}

function eventStream(
  request: Request,
  url: URL,
  store: AttentionStore,
  requestId: string,
): Response {
  const filters = parseEventFilters(url, request);
  filters.limit = 200;
  const encoder = new TextEncoder();
  let cleanup = () => {};
  let requestPump = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let cursor = filters.after;
      let closed = false;
      let pumping = false;
      let repump = false;
      const enqueue = (text: string): boolean => {
        if (closed || (controller.desiredSize ?? 1) <= 0) return false;
        controller.enqueue(encoder.encode(text));
        return true;
      };
      const pump = () => {
        if (closed) return;
        if (pumping) {
          repump = true;
          return;
        }
        pumping = true;
        try {
          do {
            repump = false;
            while (!closed) {
              const page = store.listEvents({ ...filters, after: cursor });
              for (const event of page.events) {
                if (event.cursor <= cursor) continue;
                if (
                  !enqueue(
                    `id: ${event.cursor}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`,
                  )
                ) {
                  return;
                }
                cursor = event.cursor;
              }
              if (page.events.length < filters.limit) break;
            }
          } while (repump && !closed);
        } catch (error) {
          enqueue(`event: error\ndata: ${JSON.stringify({ code: "stream_error" })}\n\n`);
          controller.error(error);
          stop();
        } finally {
          pumping = false;
        }
      };
      const unsubscribe = store.subscribe(() => pump());
      const heartbeat = setInterval(() => enqueue(": heartbeat\n\n"), 15_000);
      const stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        request.signal.removeEventListener("abort", stop);
      };
      cleanup = stop;
      requestPump = pump;
      request.signal.addEventListener("abort", stop, { once: true });
      enqueue("retry: 2000\n\n");
      pump();
    },
    pull() {
      requestPump();
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: commonHeaders(requestId, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    }),
  });
}

async function readJson(request: Request, maximumBytes: number): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > maximumBytes) {
    throw new ServiceError("body_too_large", 413, `Request body exceeds ${maximumBytes} bytes`);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    throw new ServiceError("body_too_large", 413, `Request body exceeds ${maximumBytes} bytes`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("invalid_json", "Request body must contain valid JSON");
  }
}

function itemResponse<T extends { revision: number }>(
  item: T,
  status: number,
  requestId: string,
  extraHeaders: HeadersInit = {},
): Response {
  return json({ item }, status, requestId, {
    ETag: itemEtag(item.revision),
    ...headersObject(extraHeaders),
  });
}

function json(
  value: unknown,
  status: number,
  requestId: string,
  extraHeaders: HeadersInit = {},
): Response {
  return Response.json(value, {
    status,
    headers: commonHeaders(requestId, {
      "Cache-Control": "no-store",
      ...headersObject(extraHeaders),
    }),
  });
}

function problemResponse(error: unknown, requestId: string): Response {
  const serviceError =
    error instanceof ServiceError
      ? error
      : new ServiceError("internal_error", 500, "The service encountered an internal error");
  if (!(error instanceof ServiceError)) console.error(error);
  return Response.json(
    {
      type: `urn:agentattention:problem:${serviceError.code}`,
      title: titleForStatus(serviceError.status),
      status: serviceError.status,
      code: serviceError.code,
      detail: serviceError.message,
      requestId,
      ...(serviceError.details ? { details: serviceError.details } : {}),
    },
    {
      status: serviceError.status,
      headers: commonHeaders(requestId, {
        "Content-Type": "application/problem+json",
        "Cache-Control": "no-store",
        ...(serviceError.status === 401 ? { "WWW-Authenticate": "Bearer" } : {}),
      }),
    },
  );
}

function commonHeaders(requestId: string, extra: Record<string, string> = {}): Headers {
  return new Headers({ "X-Request-Id": requestId, ...extra });
}

function itemEtag(revision: number): string {
  return `"revision-${revision}"`;
}

function titleForStatus(status: number): string {
  if (status === 400) return "Bad Request";
  if (status === 401) return "Unauthorized";
  if (status === 403) return "Forbidden";
  if (status === 404) return "Not Found";
  if (status === 409) return "Conflict";
  if (status === 413) return "Content Too Large";
  return "Internal Server Error";
}

function assignOptional<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: string | null,
): void {
  if (value !== null && value !== "") target[key] = value as T[K];
}

function headersObject(headers: HeadersInit): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw badRequest("invalid_path", "Path contains invalid percent encoding");
  }
}
