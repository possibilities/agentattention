import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { badRequest } from "./errors.ts";
import { createId, createToken, hashToken } from "./ids.ts";

export const ALL_SCOPES = [
  "items:create",
  "items:read",
  "items:claim",
  "items:resolve",
  "items:cancel",
  "events:read",
] as const;

export interface CredentialConfig {
  id: string;
  name: string;
  tokenHash: string;
  scopes: string[];
}

export interface AppConfig {
  server: {
    host: string;
    port: number;
    maxBodyBytes: number;
  };
  database: string;
  credentials: CredentialConfig[];
}

export function defaultConfigPath(): string {
  const configured = process.env.AGENTATTENTION_CONFIG;
  return configured
    ? resolve(configured)
    : resolve(homedir(), ".config/agentattention/config.json");
}

export function defaultDatabasePath(): string {
  return resolve(homedir(), ".local/state/agentattention/agentattention.sqlite3");
}

export function createInitialConfig(): { config: AppConfig; token: string } {
  const token = createToken();
  return {
    token,
    config: {
      server: { host: "127.0.0.1", port: 7331, maxBodyBytes: 1_048_576 },
      database: defaultDatabasePath(),
      credentials: [
        {
          id: createId("cred"),
          name: "administrator",
          tokenHash: hashToken(token),
          scopes: ["admin"],
        },
      ],
    },
  };
}

export function loadConfig(path = defaultConfigPath()): AppConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw badRequest(
      "config_unreadable",
      `Cannot read configuration at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateConfig(parsed);
}

export function saveConfig(path: string, config: AppConfig): void {
  validateConfig(config);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

export function addCredential(
  config: AppConfig,
  name: string,
  scopes: string[],
): { config: AppConfig; credential: CredentialConfig; token: string } {
  if (!name.trim() || name.length > 100) {
    throw badRequest("invalid_credential_name", "Credential name must be 1 to 100 characters");
  }
  validateScopes(scopes);
  const token = createToken();
  const credential = {
    id: createId("cred"),
    name: name.trim(),
    tokenHash: hashToken(token),
    scopes: [...new Set(scopes)],
  };
  return {
    config: { ...config, credentials: [...config.credentials, credential] },
    credential,
    token,
  };
}

export function validateConfig(value: unknown): AppConfig {
  if (!isRecord(value) || !isRecord(value.server) || !Array.isArray(value.credentials)) {
    throw badRequest("invalid_config", "Configuration has an invalid shape");
  }
  const { server } = value;
  if (server.host !== "127.0.0.1" && server.host !== "::1" && server.host !== "localhost") {
    throw badRequest("non_loopback_host", "Version 1 only accepts a loopback server host");
  }
  if (!Number.isInteger(server.port) || Number(server.port) < 1 || Number(server.port) > 65535) {
    throw badRequest("invalid_config", "server.port must be an integer from 1 to 65535");
  }
  if (
    !Number.isInteger(server.maxBodyBytes) ||
    Number(server.maxBodyBytes) < 1024 ||
    Number(server.maxBodyBytes) > 16_777_216
  ) {
    throw badRequest("invalid_config", "server.maxBodyBytes must be between 1024 and 16777216");
  }
  if (typeof value.database !== "string" || !value.database) {
    throw badRequest("invalid_config", "database must be a non-empty path");
  }
  if (!isAbsolute(value.database)) {
    throw badRequest("invalid_config", "database must be an absolute path");
  }
  const credentials = value.credentials.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.name !== "string" ||
      typeof entry.tokenHash !== "string" ||
      !Array.isArray(entry.scopes) ||
      !entry.scopes.every((scope) => typeof scope === "string")
    ) {
      throw badRequest("invalid_config", "A credential has an invalid shape");
    }
    validateScopes(entry.scopes);
    return {
      id: entry.id,
      name: entry.name,
      tokenHash: entry.tokenHash,
      scopes: [...entry.scopes],
    };
  });
  if (new Set(credentials.map((entry) => entry.id)).size !== credentials.length) {
    throw badRequest("invalid_config", "Credential ids must be unique");
  }
  return {
    server: {
      host: server.host,
      port: Number(server.port),
      maxBodyBytes: Number(server.maxBodyBytes),
    },
    database: resolve(value.database),
    credentials,
  };
}

function validateScopes(scopes: string[]): void {
  if (scopes.length === 0) {
    throw badRequest("invalid_scopes", "At least one scope is required");
  }
  const valid = new Set<string>([...ALL_SCOPES, "admin"]);
  const unknown = scopes.filter((scope) => !valid.has(scope));
  if (unknown.length > 0) {
    throw badRequest("invalid_scopes", `Unknown scopes: ${unknown.join(", ")}`);
  }
  if (scopes.includes("admin") && scopes.length !== 1) {
    throw badRequest("invalid_scopes", "The admin scope must be used by itself");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
