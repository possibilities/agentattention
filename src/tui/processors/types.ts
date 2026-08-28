import type { JsonValue } from "../../domain.ts";

export type ProcessorDecision =
  | { kind: "resolve"; resolution: JsonValue }
  | { kind: "return"; reason: string; comment: string | null }
  | { kind: "back" };
