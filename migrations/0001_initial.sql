CREATE TABLE attention_items (
  id TEXT PRIMARY KEY,
  contract TEXT NOT NULL,
  title TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  labels_json TEXT NOT NULL DEFAULT '{}',
  correlation_id TEXT,
  parent_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'cancelled', 'expired')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  cancelled_by TEXT,
  cancelled_at TEXT,
  cancellation_reason TEXT
);

CREATE INDEX attention_items_order
  ON attention_items(status, priority DESC, created_at, id);
CREATE INDEX attention_items_contract
  ON attention_items(contract, status, priority DESC, created_at, id);
CREATE INDEX attention_items_correlation
  ON attention_items(correlation_id, created_at, id);
CREATE INDEX attention_items_expiry
  ON attention_items(expires_at) WHERE status = 'open' AND expires_at IS NOT NULL;

CREATE TABLE claims (
  item_id TEXT PRIMARY KEY REFERENCES attention_items(id) ON DELETE CASCADE,
  claim_id TEXT NOT NULL UNIQUE,
  holder_id TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX claims_expiry ON claims(expires_at);

CREATE TABLE resolutions (
  item_id TEXT PRIMARY KEY REFERENCES attention_items(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL,
  resolved_by TEXT NOT NULL,
  resolved_at TEXT NOT NULL
);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL REFERENCES attention_items(id) ON DELETE CASCADE,
  item_revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  actor_id TEXT,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX events_item_seq ON events(item_id, seq);

CREATE TABLE idempotency (
  principal_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES attention_items(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(principal_id, operation, idempotency_key)
);

PRAGMA user_version = 1;
