CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','viewer')),
  expires_at INTEGER NOT NULL
);
CREATE TABLE login_limits (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
CREATE TABLE strategies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO strategies(id,name) VALUES ('twenty-minute','20分钟策略'),('898','898号策略'),('unclassified','未分类');
CREATE TABLE batches (
  id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  input_hash TEXT NOT NULL
);
CREATE TABLE records (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  strategy_id TEXT NOT NULL REFERENCES strategies(id),
  version TEXT NOT NULL DEFAULT '',
  symbol TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  original_time TEXT NOT NULL,
  buy_time TEXT NOT NULL,
  actual_price REAL,
  shares REAL,
  reason TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  checked_through TEXT,
  reference_price REAL,
  pricing_status TEXT NOT NULL DEFAULT 'pending',
  reference_evidence TEXT,
  market_data TEXT,
  fetched_at TEXT,
  error TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX records_buy_time ON records(buy_time);
CREATE INDEX records_strategy ON records(strategy_id);
CREATE TABLE audit (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  previous_value TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE market_cache (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
