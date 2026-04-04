-- Minimal chat store layout aligned with Cursor chat-store snapshots (meta + blobs).
-- Template version: see GOLDEN_STORE_TEMPLATE_VERSION in store-template-hydrate.ts
PRAGMA user_version = 1;
PRAGMA journal_mode = WAL;
CREATE TABLE meta (key TEXT PRIMARY KEY, value BLOB NOT NULL);
CREATE TABLE blobs (id TEXT PRIMARY KEY, value BLOB NOT NULL);
INSERT INTO meta (key, value) VALUES (
  '0',
  CAST('{"agentId":"00000000-0000-4000-8000-000000000001","latestRootBlobId":"root","name":"Template","mode":"default","createdAt":1774271599578}' AS BLOB)
);
INSERT INTO blobs (id, value) VALUES (
  'root',
  CAST('[{"role":"user","content":[{"type":"text","text":"__PLACEHOLDER__"}]}]' AS BLOB)
);
