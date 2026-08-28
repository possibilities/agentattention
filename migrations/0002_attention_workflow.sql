CREATE TABLE attention_items_v2 (
  id TEXT PRIMARY KEY,
  contract TEXT NOT NULL,
  title TEXT NOT NULL,
  context TEXT,
  payload_json TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  labels_json TEXT NOT NULL DEFAULT '{}',
  correlation_id TEXT,
  parent_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'returned', 'cancelled', 'expired')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  use_before TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  cancelled_by TEXT,
  cancelled_at TEXT,
  cancellation_reason TEXT
);

INSERT INTO attention_items_v2 (
  id, contract, title, context, payload_json, priority, labels_json,
  correlation_id, parent_id, status, created_by, created_at, updated_at,
  use_before, revision, cancelled_by, cancelled_at, cancellation_reason
)
SELECT
  id, contract, title, NULL, payload_json, priority, labels_json,
  correlation_id, parent_id, status, created_by, created_at, updated_at,
  expires_at, revision, cancelled_by, cancelled_at, cancellation_reason
FROM attention_items;

DROP TABLE attention_items;
ALTER TABLE attention_items_v2 RENAME TO attention_items;

CREATE INDEX attention_items_order
  ON attention_items(status, priority DESC, created_at, id);
CREATE INDEX attention_items_contract
  ON attention_items(contract, status, priority DESC, created_at, id);
CREATE INDEX attention_items_correlation
  ON attention_items(correlation_id, created_at, id);
CREATE INDEX attention_items_use_before
  ON attention_items(use_before) WHERE status = 'open' AND use_before IS NOT NULL;

CREATE TABLE return_outcomes (
  item_id TEXT PRIMARY KEY REFERENCES attention_items(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  comment TEXT,
  returned_by TEXT NOT NULL,
  returned_at TEXT NOT NULL
);

PRAGMA user_version = 2;
