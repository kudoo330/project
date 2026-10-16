CREATE TABLE IF NOT EXISTS strategy_analysis_rules (
  strategy_id TEXT PRIMARY KEY REFERENCES strategies(id),
  rule_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
