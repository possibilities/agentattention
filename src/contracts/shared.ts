import { badRequest } from "../errors.ts";

export function contractRecord(value: unknown, contract: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("invalid_contract_payload", `${contract} payload must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function contractString(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw badRequest(
      "invalid_contract_payload",
      `${path} must be a non-empty string of at most ${maximum} characters`,
    );
  }
  return value.trim();
}

export function optionalContractString(
  value: unknown,
  path: string,
  maximum: number,
): string | null {
  if (value === undefined || value === null) return null;
  return contractString(value, path, maximum);
}

export function rejectContractFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const fields = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !fields.has(key));
  if (unknown.length > 0) {
    throw badRequest(
      "invalid_contract_payload",
      `${path} contains unknown fields: ${unknown.join(", ")}`,
    );
  }
}

export function contractIdentifier(value: unknown, path: string): string {
  const identifier = contractString(value, path, 64);
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(identifier)) {
    throw badRequest(
      "invalid_contract_payload",
      `${path} must start with a lowercase letter and contain only lowercase letters, digits, ., _, or -`,
    );
  }
  return identifier;
}
