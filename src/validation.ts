import type { AttentionStatus, CreateItemInput, JsonValue } from "./domain.ts";
import { badRequest } from "./errors.ts";

export function parseCreateItem(value: unknown, now = new Date()): CreateItemInput {
  const input = requireRecord(value, "Request body must be a JSON object");
  rejectUnknown(input, [
    "contract",
    "title",
    "payload",
    "priority",
    "labels",
    "correlationId",
    "parentId",
    "expiresAt",
  ]);
  const contract = boundedString(input.contract, "contract", 1, 255);
  const title = boundedString(input.title, "title", 1, 500);
  if (!Object.hasOwn(input, "payload")) {
    throw badRequest(
      "invalid_item",
      "payload is required (use null when the contract has no data)",
    );
  }
  assertJson(input.payload, "payload");
  const priority =
    input.priority === undefined
      ? 0
      : boundedInteger(input.priority, "priority", -1_000_000, 1_000_000);
  const labels = input.labels === undefined ? {} : parseLabels(input.labels);
  const correlationId = optionalIdentifier(input.correlationId, "correlationId");
  const parentId = optionalIdentifier(input.parentId, "parentId");
  const expiresAt = optionalTimestamp(input.expiresAt, "expiresAt");
  if (expiresAt !== null && new Date(expiresAt).getTime() <= now.getTime()) {
    throw badRequest("invalid_expiry", "expiresAt must be in the future");
  }
  return {
    contract,
    title,
    payload: input.payload,
    priority,
    labels,
    correlationId,
    parentId,
    expiresAt,
  };
}

export function parseClaim(value: unknown): { leaseSeconds: number } {
  const input = requireRecord(value, "Request body must be a JSON object");
  rejectUnknown(input, ["leaseSeconds"]);
  return {
    leaseSeconds:
      input.leaseSeconds === undefined
        ? 300
        : boundedInteger(input.leaseSeconds, "leaseSeconds", 5, 86_400),
  };
}

export function parseClaimMutation(value: unknown): { claimId: string; leaseSeconds?: number } {
  const input = requireRecord(value, "Request body must be a JSON object");
  rejectUnknown(input, ["claimId", "leaseSeconds"]);
  const claimId = boundedString(input.claimId, "claimId", 1, 100);
  if (input.leaseSeconds === undefined) {
    return { claimId };
  }
  return {
    claimId,
    leaseSeconds: boundedInteger(input.leaseSeconds, "leaseSeconds", 5, 86_400),
  };
}

export function parseResolution(value: unknown): { claimId: string | null; resolution: JsonValue } {
  const input = requireRecord(value, "Request body must be a JSON object");
  rejectUnknown(input, ["claimId", "resolution"]);
  const claimId =
    input.claimId === undefined || input.claimId === null
      ? null
      : boundedString(input.claimId, "claimId", 1, 100);
  if (!Object.hasOwn(input, "resolution")) {
    throw badRequest(
      "invalid_resolution",
      "resolution is required (use null for an empty resolution)",
    );
  }
  assertJson(input.resolution, "resolution");
  return { claimId, resolution: input.resolution };
}

export function parseCancellation(value: unknown): { reason: string } {
  const input = requireRecord(value, "Request body must be a JSON object");
  rejectUnknown(input, ["reason"]);
  return { reason: boundedString(input.reason, "reason", 1, 1_000) };
}

export function parseStatus(value: string | null): AttentionStatus | undefined {
  if (value === null || value === "") return undefined;
  if (value === "open" || value === "resolved" || value === "cancelled" || value === "expired") {
    return value;
  }
  throw badRequest("invalid_filter", `Unknown status: ${value}`);
}

export function parsePositiveInteger(
  value: string | null,
  name: string,
  defaultValue: number,
  maximum: number,
): number {
  if (value === null || value === "") return defaultValue;
  if (!/^\d+$/.test(value)) {
    throw badRequest("invalid_filter", `${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw badRequest("invalid_filter", `${name} must be between 0 and ${maximum}`);
  }
  return parsed;
}

export function validateIdempotencyKey(value: string | null): string {
  if (value === null || value.length < 1 || value.length > 200) {
    throw badRequest("missing_idempotency_key", "Idempotency-Key must be 1 to 200 characters");
  }
  return value;
}

export function assertJson(value: unknown, path: string): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw badRequest("invalid_json_value", `${path} must not contain a non-finite number`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertJson(value[index], `${path}[${index}]`);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assertJson(child, `${path}.${key}`);
    }
    return;
  }
  throw badRequest("invalid_json_value", `${path} must be a JSON value`);
}

function parseLabels(value: unknown): Record<string, string> {
  const labels = requireRecord(value, "labels must be an object of string values");
  const entries = Object.entries(labels);
  if (entries.length > 32) {
    throw badRequest("invalid_labels", "labels may contain at most 32 entries");
  }
  const result: Record<string, string> = {};
  for (const [key, labelValue] of entries) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(key)) {
      throw badRequest("invalid_labels", `Invalid label key: ${key}`);
    }
    if (typeof labelValue !== "string" || labelValue.length > 256) {
      throw badRequest("invalid_labels", `Label ${key} must be a string of at most 256 characters`);
    }
    result[key] = labelValue;
  }
  return result;
}

function optionalIdentifier(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  return boundedString(value, name, 1, 255);
}

function optionalTimestamp(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  const text = boundedString(value, name, 1, 100);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    throw badRequest("invalid_timestamp", `${name} must be an RFC 3339 timestamp with a timezone`);
  }
  const timestamp = new Date(text);
  if (Number.isNaN(timestamp.getTime())) {
    throw badRequest("invalid_timestamp", `${name} must be an RFC 3339 timestamp`);
  }
  return timestamp.toISOString();
}

function boundedString(value: unknown, name: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.trim().length < minimum || value.length > maximum) {
    throw badRequest("invalid_field", `${name} must be ${minimum} to ${maximum} characters`);
  }
  return value.trim();
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw badRequest("invalid_field", `${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("invalid_body", message);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(input: Record<string, unknown>, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(input).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw badRequest("unknown_fields", `Unknown fields: ${unknown.join(", ")}`);
  }
}
