export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type AttentionStatus = "open" | "resolved" | "cancelled" | "expired";

export interface Principal {
  id: string;
  name: string;
  scopes: string[];
}

export interface Claim {
  id: string;
  holder: string;
  claimedAt: string;
  expiresAt: string;
}

export interface Resolution {
  payload: JsonValue;
  resolvedBy: string;
  resolvedAt: string;
}

export interface Cancellation {
  reason: string;
  cancelledBy: string;
  cancelledAt: string;
}

export interface AttentionItem {
  id: string;
  contract: string;
  title: string;
  payload: JsonValue;
  priority: number;
  labels: Record<string, string>;
  correlationId: string | null;
  parentId: string | null;
  status: AttentionStatus;
  claim: Claim | null;
  resolution: Resolution | null;
  cancellation: Cancellation | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  revision: number;
}

export interface AttentionEvent {
  cursor: number;
  itemId: string;
  itemRevision: number;
  contract: string;
  correlationId: string | null;
  kind: string;
  actor: string | null;
  data: JsonValue;
  occurredAt: string;
}

export interface CreateItemInput {
  contract: string;
  title: string;
  payload: JsonValue;
  priority?: number;
  labels?: Record<string, string>;
  correlationId?: string | null;
  parentId?: string | null;
  expiresAt?: string | null;
}

export interface ItemFilters {
  status?: AttentionStatus;
  contract?: string;
  correlationId?: string;
  labels?: Record<string, string>;
  claimed?: "any" | "claimed" | "unclaimed" | "mine";
  principalId?: string;
  cursor?: string;
  limit: number;
}

export interface EventFilters {
  after: number;
  limit: number;
  itemId?: string;
  contract?: string;
  correlationId?: string;
}
