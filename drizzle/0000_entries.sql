CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  song TEXT NOT NULL,
  artist TEXT NOT NULL,
  words_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entries_owner_created_at
  ON entries(owner_id, created_at);
