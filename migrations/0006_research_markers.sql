-- Separate manual research annotations; no changes to A-share records.
CREATE TABLE research_annotation_state (
  id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0,
  last_import_id TEXT, updated_at TEXT NOT NULL
);
INSERT INTO research_annotation_state(id,updated_at) VALUES(1,CURRENT_TIMESTAMP);
CREATE TABLE research_annotation_groups (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN(0,1)),
  revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE research_annotations (
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES research_annotation_groups(id),
  symbol TEXT NOT NULL CHECK(symbol IN('AMD.US','AMDL.US')),
  action TEXT NOT NULL CHECK(action IN('BUY','SELL','REBUY')),
  time_utc TEXT NOT NULL, original_time TEXT NOT NULL, price REAL CHECK(price IS NULL OR price>0),
  source_type TEXT NOT NULL CHECK(source_type IN('manual_hypothesis','user_reported_trade')),
  notes TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN('candidate','confirmed','invalidated')),
  source_note TEXT NOT NULL, pair_id TEXT, reference_json TEXT,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN(0,1)),
  revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX research_annotations_time ON research_annotations(symbol,time_utc,id);
CREATE INDEX research_annotations_group ON research_annotations(group_id,time_utc,id);
CREATE INDEX research_annotations_pair ON research_annotations(pair_id);
CREATE UNIQUE INDEX research_annotations_pair_action ON research_annotations(pair_id,action) WHERE pair_id IS NOT NULL AND deleted=0;
CREATE TABLE research_annotation_batches (
  id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, actor TEXT NOT NULL,
  operation TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE research_annotation_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES research_annotation_batches(id), actor TEXT NOT NULL,
  operation TEXT NOT NULL, previous_json TEXT, new_json TEXT NOT NULL,
  reason TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX research_annotation_audit_entity ON research_annotation_audit(entity_type,entity_id,id);
