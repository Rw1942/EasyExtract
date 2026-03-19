PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS buckets_new;

CREATE TABLE buckets_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  settings TEXT,
  auto_route_rules TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO buckets_new (id, name, settings, auto_route_rules, created_at)
SELECT id, name, settings, auto_route_rules, created_at
FROM buckets;

DROP TABLE buckets;
ALTER TABLE buckets_new RENAME TO buckets;

PRAGMA foreign_keys = ON;
