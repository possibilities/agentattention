import { createHash, randomBytes, randomUUID } from "node:crypto";

export function createId(prefix: "attn" | "clm" | "cred"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function createToken(): string {
  return `aat_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

export function hashJson(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
