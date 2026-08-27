import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  AttentionEvent,
  AttentionItem,
  AttentionStatus,
  Claim,
  CreateItemInput,
  EventFilters,
  ItemFilters,
  JsonValue,
} from "./domain.ts";
import { badRequest, conflict, notFound } from "./errors.ts";
import { createId, hashJson } from "./ids.ts";

interface ItemRow {
  id: string;
  contract: string;
  title: string;
  payload_json: string;
  priority: number;
  labels_json: string;
  correlation_id: string | null;
  parent_id: string | null;
  status: AttentionStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  revision: number;
  cancelled_by: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  claim_id: string | null;
  claim_holder_id: string | null;
  claim_claimed_at: string | null;
  claim_expires_at: string | null;
  resolution_json: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
}

interface EventRow {
  seq: number;
  item_id: string;
  item_revision: number;
  contract: string;
  correlation_id: string | null;
  kind: string;
  actor_id: string | null;
  data_json: string;
  created_at: string;
}

interface IdempotencyRow {
  request_hash: string;
  item_id: string;
}

interface WriteContext {
  eventCursors: number[];
}

export interface ItemPage {
  items: AttentionItem[];
  nextCursor: string | null;
}

export interface EventPage {
  events: AttentionEvent[];
  nextCursor: number;
}

const ITEM_SELECT = `
  SELECT i.*,
    c.claim_id,
    c.holder_id AS claim_holder_id,
    c.claimed_at AS claim_claimed_at,
    c.expires_at AS claim_expires_at,
    r.payload_json AS resolution_json,
    r.resolved_by,
    r.resolved_at
  FROM attention_items i
  LEFT JOIN claims c ON c.item_id = i.id
  LEFT JOIN resolutions r ON r.item_id = i.id
`;

export class AttentionStore {
  readonly db: Database;
  private readonly subscribers = new Set<(cursor: number) => void>();
  private readonly now: () => Date;

  constructor(databasePath: string, options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(resolve(databasePath)), { recursive: true, mode: 0o700 });
    }
    this.db = new Database(databasePath, { create: true, strict: true });
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  subscribe(listener: (cursor: number) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  createItem(input: CreateItemInput, principalId: string, idempotencyKey: string): AttentionItem {
    this.sweepExpired();
    const normalized = {
      contract: input.contract,
      title: input.title,
      payload: input.payload,
      priority: input.priority ?? 0,
      labels: input.labels ?? {},
      correlationId: input.correlationId ?? null,
      parentId: input.parentId ?? null,
      expiresAt: input.expiresAt ?? null,
    };
    const requestHash = hashJson(normalized);
    return this.write((context) => {
      const replay = this.readIdempotency(principalId, "create", idempotencyKey, requestHash);
      if (replay) return replay;
      if (normalized.parentId !== null) {
        const parent = this.db
          .query("SELECT 1 FROM attention_items WHERE id = ?")
          .get(normalized.parentId);
        if (!parent)
          throw conflict("parent_not_found", "parentId does not name an existing attention item");
      }
      const id = createId("attn");
      const timestamp = this.timestamp();
      this.db
        .query(
          `INSERT INTO attention_items
            (id, contract, title, payload_json, priority, labels_json, correlation_id, parent_id,
             status, created_by, created_at, updated_at, expires_at, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, 1)`,
        )
        .run(
          id,
          normalized.contract,
          normalized.title,
          JSON.stringify(normalized.payload),
          normalized.priority,
          JSON.stringify(normalized.labels),
          normalized.correlationId,
          normalized.parentId,
          principalId,
          timestamp,
          timestamp,
          normalized.expiresAt,
        );
      this.insertEvent(
        context,
        id,
        1,
        "item.created",
        principalId,
        { item: normalized },
        timestamp,
      );
      const item = this.readItem(id);
      this.writeIdempotency(principalId, "create", idempotencyKey, requestHash, item.id, timestamp);
      return item;
    });
  }

  getItem(id: string): AttentionItem {
    this.sweepExpired();
    const item = this.readItemOrNull(id);
    if (!item) throw notFound();
    return item;
  }

  listItems(filters: ItemFilters): ItemPage {
    this.sweepExpired();
    const conditions: string[] = [];
    const bindings: Array<string | number> = [];
    if (filters.status) {
      conditions.push("i.status = ?");
      bindings.push(filters.status);
    }
    if (filters.contract) {
      conditions.push("i.contract = ?");
      bindings.push(filters.contract);
    }
    if (filters.correlationId) {
      conditions.push("i.correlation_id = ?");
      bindings.push(filters.correlationId);
    }
    for (const [key, value] of Object.entries(filters.labels ?? {})) {
      conditions.push("json_extract(i.labels_json, ?) = ?");
      bindings.push(jsonPathKey(key), value);
    }
    if (filters.claimed === "claimed") conditions.push("c.item_id IS NOT NULL");
    if (filters.claimed === "unclaimed") conditions.push("c.item_id IS NULL");
    if (filters.claimed === "mine") {
      conditions.push("c.holder_id = ?");
      bindings.push(filters.principalId ?? "");
    }
    if (filters.cursor) {
      const cursor = decodeItemCursor(filters.cursor);
      conditions.push(
        "(i.priority < ? OR (i.priority = ? AND (i.created_at > ? OR (i.created_at = ? AND i.id > ?))))",
      );
      bindings.push(
        cursor.priority,
        cursor.priority,
        cursor.createdAt,
        cursor.createdAt,
        cursor.id,
      );
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .query<ItemRow, Array<string | number>>(
        `${ITEM_SELECT} ${where} ORDER BY i.priority DESC, i.created_at, i.id LIMIT ?`,
      )
      .all(...bindings, filters.limit + 1);
    const hasMore = rows.length > filters.limit;
    const pageRows = hasMore ? rows.slice(0, filters.limit) : rows;
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(rowToItem),
      nextCursor:
        hasMore && last
          ? encodeItemCursor({ priority: last.priority, createdAt: last.created_at, id: last.id })
          : null,
    };
  }

  claimItem(id: string, holderId: string, leaseSeconds: number): AttentionItem {
    this.sweepExpired();
    return this.write((context) => {
      const item = this.readItemOrNull(id);
      if (!item) throw notFound();
      if (item.status !== "open")
        throw conflict("item_not_open", `Cannot claim an item in ${item.status} state`);
      if (item.claim) {
        if (item.claim.holder === holderId) return item;
        throw conflict("already_claimed", "Attention item is already claimed by another principal");
      }
      const timestamp = this.timestamp();
      const claim: Claim = {
        id: createId("clm"),
        holder: holderId,
        claimedAt: timestamp,
        expiresAt: addSeconds(timestamp, leaseSeconds),
      };
      this.db
        .query(
          "INSERT INTO claims(item_id, claim_id, holder_id, claimed_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(id, claim.id, claim.holder, claim.claimedAt, claim.expiresAt);
      const revision = this.bumpRevision(id, timestamp);
      this.insertEvent(context, id, revision, "item.claimed", holderId, { claim }, timestamp);
      return this.readItem(id);
    });
  }

  renewClaim(id: string, claimId: string, holderId: string, leaseSeconds: number): AttentionItem {
    this.sweepExpired();
    return this.write((context) => {
      const item = this.readItemOrNull(id);
      if (!item) throw notFound();
      assertHeldClaim(item, claimId, holderId);
      const timestamp = this.timestamp();
      const expiresAt = addSeconds(timestamp, leaseSeconds);
      this.db.query("UPDATE claims SET expires_at = ? WHERE item_id = ?").run(expiresAt, id);
      const revision = this.bumpRevision(id, timestamp);
      this.insertEvent(
        context,
        id,
        revision,
        "item.claim.renewed",
        holderId,
        { claimId, expiresAt },
        timestamp,
      );
      return this.readItem(id);
    });
  }

  releaseClaim(id: string, claimId: string, holderId: string): AttentionItem {
    this.sweepExpired();
    return this.write((context) => {
      const item = this.readItemOrNull(id);
      if (!item) throw notFound();
      assertHeldClaim(item, claimId, holderId);
      const timestamp = this.timestamp();
      this.db.query("DELETE FROM claims WHERE item_id = ?").run(id);
      const revision = this.bumpRevision(id, timestamp);
      this.insertEvent(
        context,
        id,
        revision,
        "item.claim.released",
        holderId,
        { claimId },
        timestamp,
      );
      return this.readItem(id);
    });
  }

  resolveItem(
    id: string,
    claimId: string | null,
    resolution: JsonValue,
    principalId: string,
    idempotencyKey: string,
  ): AttentionItem {
    this.sweepExpired();
    const request = { claimId, resolution };
    const requestHash = hashJson(request);
    const operation = `resolve:${id}`;
    return this.write((context) => {
      const replay = this.readIdempotency(principalId, operation, idempotencyKey, requestHash);
      if (replay) return replay;
      const item = this.readItemOrNull(id);
      if (!item) throw notFound();
      assertCanResolve(item, claimId, principalId);
      const timestamp = this.timestamp();
      this.db
        .query(
          "INSERT INTO resolutions(item_id, payload_json, resolved_by, resolved_at) VALUES (?, ?, ?, ?)",
        )
        .run(id, JSON.stringify(resolution), principalId, timestamp);
      this.db.query("DELETE FROM claims WHERE item_id = ?").run(id);
      const revision = this.setTerminalStatus(id, "resolved", timestamp);
      this.insertEvent(
        context,
        id,
        revision,
        "item.resolved",
        principalId,
        claimId ? { claimId, resolution } : { resolution },
        timestamp,
      );
      const result = this.readItem(id);
      this.writeIdempotency(
        principalId,
        operation,
        idempotencyKey,
        requestHash,
        result.id,
        timestamp,
      );
      return result;
    });
  }

  cancelItem(
    id: string,
    reason: string,
    principalId: string,
    idempotencyKey: string,
  ): AttentionItem {
    this.sweepExpired();
    const requestHash = hashJson({ reason });
    const operation = `cancel:${id}`;
    return this.write((context) => {
      const replay = this.readIdempotency(principalId, operation, idempotencyKey, requestHash);
      if (replay) return replay;
      const item = this.readItemOrNull(id);
      if (!item) throw notFound();
      if (item.status !== "open")
        throw conflict("item_not_open", `Cannot cancel an item in ${item.status} state`);
      const timestamp = this.timestamp();
      this.db.query("DELETE FROM claims WHERE item_id = ?").run(id);
      this.db
        .query(
          `UPDATE attention_items
           SET status = 'cancelled', cancelled_by = ?, cancelled_at = ?, cancellation_reason = ?,
               updated_at = ?, revision = revision + 1
           WHERE id = ?`,
        )
        .run(principalId, timestamp, reason, timestamp, id);
      const revision = this.itemRevision(id);
      this.insertEvent(context, id, revision, "item.cancelled", principalId, { reason }, timestamp);
      const result = this.readItem(id);
      this.writeIdempotency(
        principalId,
        operation,
        idempotencyKey,
        requestHash,
        result.id,
        timestamp,
      );
      return result;
    });
  }

  listEvents(filters: EventFilters): EventPage {
    const conditions = ["e.seq > ?"];
    const bindings: Array<string | number> = [filters.after];
    if (filters.itemId) {
      conditions.push("e.item_id = ?");
      bindings.push(filters.itemId);
    }
    if (filters.contract) {
      conditions.push("i.contract = ?");
      bindings.push(filters.contract);
    }
    if (filters.correlationId) {
      conditions.push("i.correlation_id = ?");
      bindings.push(filters.correlationId);
    }
    const rows = this.db
      .query<EventRow, Array<string | number>>(
        `SELECT e.*, i.contract, i.correlation_id
         FROM events e JOIN attention_items i ON i.id = e.item_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY e.seq LIMIT ?`,
      )
      .all(...bindings, filters.limit);
    const events = rows.map(rowToEvent);
    return { events, nextCursor: events.at(-1)?.cursor ?? filters.after };
  }

  latestEventCursor(): number {
    const row = this.db
      .query<{ cursor: number }, []>("SELECT COALESCE(MAX(seq), 0) AS cursor FROM events")
      .get();
    return row?.cursor ?? 0;
  }

  sweepExpired(): number {
    const timestamp = this.timestamp();
    const due = this.db
      .query<{ count: number }, [string, string]>(
        `SELECT
          (SELECT COUNT(*) FROM attention_items WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= ?)
          + (SELECT COUNT(*) FROM claims WHERE expires_at <= ?) AS count`,
      )
      .get(timestamp, timestamp);
    if (!due || due.count === 0) return 0;
    return this.write((context) => {
      let count = 0;
      const expiredItems = this.db
        .query<{ id: string; revision: number; claim_id: string | null }, [string]>(
          `SELECT i.id, i.revision, c.claim_id
           FROM attention_items i LEFT JOIN claims c ON c.item_id = i.id
           WHERE i.status = 'open' AND i.expires_at IS NOT NULL AND i.expires_at <= ?`,
        )
        .all(timestamp);
      for (const item of expiredItems) {
        this.db.query("DELETE FROM claims WHERE item_id = ?").run(item.id);
        const revision = this.setTerminalStatus(item.id, "expired", timestamp);
        this.insertEvent(
          context,
          item.id,
          revision,
          "item.expired",
          null,
          item.claim_id ? { claimId: item.claim_id } : {},
          timestamp,
        );
        count += 1;
      }
      const expiredClaims = this.db
        .query<{ item_id: string; claim_id: string; holder_id: string }, [string]>(
          `SELECT c.item_id, c.claim_id, c.holder_id
           FROM claims c JOIN attention_items i ON i.id = c.item_id
           WHERE i.status = 'open' AND c.expires_at <= ?`,
        )
        .all(timestamp);
      for (const claim of expiredClaims) {
        this.db.query("DELETE FROM claims WHERE item_id = ?").run(claim.item_id);
        const revision = this.bumpRevision(claim.item_id, timestamp);
        this.insertEvent(
          context,
          claim.item_id,
          revision,
          "item.claim.expired",
          null,
          { claimId: claim.claim_id, holder: claim.holder_id },
          timestamp,
        );
        count += 1;
      }
      return count;
    });
  }

  private migrate(): void {
    const version =
      this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    if (version > 1) {
      throw new Error(`Database schema version ${version} is newer than this binary supports`);
    }
    if (version === 0) {
      const migration = readFileSync(
        resolve(import.meta.dir, "../migrations/0001_initial.sql"),
        "utf8",
      );
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(migration);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  private write<T>(operation: (context: WriteContext) => T): T {
    const context: WriteContext = { eventCursors: [] };
    this.db.exec("BEGIN IMMEDIATE");
    let result: T;
    try {
      result = operation(context);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    for (const cursor of context.eventCursors) {
      for (const subscriber of this.subscribers) {
        try {
          subscriber(cursor);
        } catch (error) {
          console.error("Event subscriber failed", error);
        }
      }
    }
    return result;
  }

  private readItem(id: string): AttentionItem {
    const item = this.readItemOrNull(id);
    if (!item) throw notFound();
    return item;
  }

  private readItemOrNull(id: string): AttentionItem | null {
    const row = this.db.query<ItemRow, [string]>(`${ITEM_SELECT} WHERE i.id = ?`).get(id);
    return row ? rowToItem(row) : null;
  }

  private bumpRevision(id: string, timestamp: string): number {
    this.db
      .query("UPDATE attention_items SET updated_at = ?, revision = revision + 1 WHERE id = ?")
      .run(timestamp, id);
    return this.itemRevision(id);
  }

  private setTerminalStatus(id: string, status: "resolved" | "expired", timestamp: string): number {
    this.db
      .query(
        "UPDATE attention_items SET status = ?, updated_at = ?, revision = revision + 1 WHERE id = ?",
      )
      .run(status, timestamp, id);
    return this.itemRevision(id);
  }

  private itemRevision(id: string): number {
    const row = this.db
      .query<{ revision: number }, [string]>("SELECT revision FROM attention_items WHERE id = ?")
      .get(id);
    if (!row) throw notFound();
    return row.revision;
  }

  private insertEvent(
    context: WriteContext,
    itemId: string,
    itemRevision: number,
    kind: string,
    actorId: string | null,
    data: unknown,
    timestamp: string,
  ): void {
    const result = this.db
      .query(
        `INSERT INTO events(item_id, item_revision, kind, actor_id, data_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(itemId, itemRevision, kind, actorId, JSON.stringify(data), timestamp);
    context.eventCursors.push(Number(result.lastInsertRowid));
  }

  private readIdempotency(
    principalId: string,
    operation: string,
    key: string,
    requestHash: string,
  ): AttentionItem | null {
    const row = this.db
      .query<IdempotencyRow, [string, string, string]>(
        `SELECT request_hash, item_id FROM idempotency
         WHERE principal_id = ? AND operation = ? AND idempotency_key = ?`,
      )
      .get(principalId, operation, key);
    if (!row) return null;
    if (row.request_hash !== requestHash) {
      throw conflict(
        "idempotency_conflict",
        "Idempotency-Key was already used with a different request",
      );
    }
    return this.readItem(row.item_id);
  }

  private writeIdempotency(
    principalId: string,
    operation: string,
    key: string,
    requestHash: string,
    itemId: string,
    timestamp: string,
  ): void {
    this.db
      .query(
        `INSERT INTO idempotency
          (principal_id, operation, idempotency_key, request_hash, item_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(principalId, operation, key, requestHash, itemId, timestamp);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function rowToItem(row: ItemRow): AttentionItem {
  return {
    id: row.id,
    contract: row.contract,
    title: row.title,
    payload: JSON.parse(row.payload_json) as JsonValue,
    priority: row.priority,
    labels: JSON.parse(row.labels_json) as Record<string, string>,
    correlationId: row.correlation_id,
    parentId: row.parent_id,
    status: row.status,
    claim:
      row.claim_id && row.claim_holder_id && row.claim_claimed_at && row.claim_expires_at
        ? {
            id: row.claim_id,
            holder: row.claim_holder_id,
            claimedAt: row.claim_claimed_at,
            expiresAt: row.claim_expires_at,
          }
        : null,
    resolution:
      row.resolution_json !== null && row.resolved_by && row.resolved_at
        ? {
            payload: JSON.parse(row.resolution_json) as JsonValue,
            resolvedBy: row.resolved_by,
            resolvedAt: row.resolved_at,
          }
        : null,
    cancellation:
      row.cancellation_reason && row.cancelled_by && row.cancelled_at
        ? {
            reason: row.cancellation_reason,
            cancelledBy: row.cancelled_by,
            cancelledAt: row.cancelled_at,
          }
        : null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    revision: row.revision,
  };
}

function rowToEvent(row: EventRow): AttentionEvent {
  return {
    cursor: row.seq,
    itemId: row.item_id,
    itemRevision: row.item_revision,
    contract: row.contract,
    correlationId: row.correlation_id,
    kind: row.kind,
    actor: row.actor_id,
    data: JSON.parse(row.data_json) as JsonValue,
    occurredAt: row.created_at,
  };
}

function assertHeldClaim(item: AttentionItem, claimId: string, holderId: string): void {
  if (item.status !== "open") {
    throw conflict("item_not_open", `Cannot mutate a claim on an item in ${item.status} state`);
  }
  if (!item.claim) throw conflict("claim_required", "Attention item does not have an active claim");
  if (item.claim.id !== claimId || item.claim.holder !== holderId) {
    throw conflict("claim_mismatch", "Claim is not held by this principal");
  }
}

function assertCanResolve(item: AttentionItem, claimId: string | null, principalId: string): void {
  if (item.status !== "open") {
    throw conflict("item_not_open", `Cannot resolve an item in ${item.status} state`);
  }
  if (item.claim) {
    if (!claimId) {
      throw conflict("claim_required", "The active claim id is required to resolve this item");
    }
    assertHeldClaim(item, claimId, principalId);
    return;
  }
  if (claimId) throw conflict("claim_mismatch", "Attention item does not have this active claim");
}

function addSeconds(timestamp: string, seconds: number): string {
  return new Date(new Date(timestamp).getTime() + seconds * 1_000).toISOString();
}

interface ItemCursor {
  priority: number;
  createdAt: string;
  id: string;
}

function encodeItemCursor(cursor: ItemCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeItemCursor(value: string): ItemCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<ItemCursor>;
    if (
      !Number.isInteger(parsed.priority) ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.id !== "string"
    ) {
      throw new Error("shape");
    }
    return { priority: parsed.priority, createdAt: parsed.createdAt, id: parsed.id } as ItemCursor;
  } catch {
    throw badRequest("invalid_cursor", "Item cursor is invalid");
  }
}

function jsonPathKey(key: string): string {
  return `$."${key.replaceAll('"', '\\"')}"`;
}
