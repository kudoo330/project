CREATE TABLE IF NOT EXISTS close_sync_runs (
  id TEXT PRIMARY KEY,
  trade_date TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  total_symbols INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  succeeded INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  remaining INTEGER NOT NULL DEFAULT 0,
  message TEXT
);
CREATE TABLE IF NOT EXISTS close_sync_symbols (
  symbol TEXT PRIMARY KEY,
  last_attempt TEXT NOT NULL,
  last_success TEXT,
  last_error TEXT
);
