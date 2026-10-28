-- Independent administrator research data. Does not modify A-share samples.
CREATE TABLE research_market_datasets (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL CHECK(symbol IN ('AMD.US','AMDL.US')),
  period TEXT NOT NULL CHECK(period IN ('1m','1d')),
  provider TEXT NOT NULL,
  adjustment TEXT NOT NULL CHECK(adjustment IN ('none','forward')),
  adjustment_as_of TEXT,
  time_zone TEXT NOT NULL CHECK(time_zone='America/New_York'),
  currency TEXT NOT NULL CHECK(currency='USD'),
  revision INTEGER NOT NULL DEFAULT 0,
  last_import_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE research_market_import_batches (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES research_market_datasets(id),
  input_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  actor TEXT NOT NULL,
  source_note TEXT NOT NULL,
  replacement_reason TEXT NOT NULL,
  counts_json TEXT NOT NULL,
  dataset_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE research_market_bars (
  dataset_id TEXT NOT NULL REFERENCES research_market_datasets(id),
  time_key TEXT NOT NULL,
  original_time TEXT NOT NULL,
  trading_date TEXT NOT NULL,
  session TEXT NOT NULL CHECK(session IN ('regular','pre','post','overnight')),
  open REAL, high REAL, low REAL, close REAL,
  volume INTEGER CHECK(volume IS NULL OR volume>=0),
  status TEXT NOT NULL CHECK(status IN ('available','missing','not_entitled','request_failed','no_eligible_trade')),
  reason TEXT NOT NULL,
  original_values_json TEXT NOT NULL,
  source_note TEXT NOT NULL,
  verification TEXT NOT NULL DEFAULT 'unverified' CHECK(verification='unverified'),
  revision INTEGER NOT NULL,
  import_batch_id TEXT NOT NULL REFERENCES research_market_import_batches(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(dataset_id,time_key),
  CHECK((status='available' AND open IS NOT NULL AND high IS NOT NULL AND low IS NOT NULL AND close IS NOT NULL
    AND open>0 AND high>0 AND low>0 AND close>0 AND low<=open AND low<=close AND high>=open AND high>=close)
    OR (status<>'available' AND open IS NULL AND high IS NULL AND low IS NULL AND close IS NULL AND length(reason)>0))
);
CREATE INDEX research_market_bars_dates ON research_market_bars(dataset_id,trading_date,time_key);
CREATE TABLE research_market_bar_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL REFERENCES research_market_datasets(id),
  time_key TEXT NOT NULL,
  import_batch_id TEXT NOT NULL REFERENCES research_market_import_batches(id),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  previous_value TEXT,
  new_value TEXT NOT NULL,
  source_note TEXT NOT NULL,
  replacement_reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX research_market_revisions_lookup ON research_market_bar_revisions(dataset_id,time_key,id);
