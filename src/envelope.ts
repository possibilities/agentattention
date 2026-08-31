/**
 * The one output envelope. Every `--json` command emits
 * `{schema_version, ok, error, data}`; nothing else may hand-roll it.
 */

export const SCHEMA_VERSION = 1;

export interface SuccessEnvelope {
  schema_version: number;
  ok: true;
  error: null;
  data: unknown;
}

export interface FailureEnvelope {
  schema_version: number;
  ok: false;
  error: { code: string; message: string };
  data: null;
}

export function successEnvelope(data: unknown): SuccessEnvelope {
  return { schema_version: SCHEMA_VERSION, ok: true, error: null, data };
}

export function failureEnvelope(code: string, message: string): FailureEnvelope {
  return { schema_version: SCHEMA_VERSION, ok: false, error: { code, message }, data: null };
}
