-- AMD-only immutable, administrator-only hypothetical research runs.
-- No foreign key to mutable datasets: snapshots survive source correction/deletion.
CREATE TABLE research_backtest_runs (
 id TEXT PRIMARY KEY,
 request_hash TEXT NOT NULL,
 actor TEXT NOT NULL,
 created_at TEXT NOT NULL,
 metadata_json TEXT NOT NULL
);
CREATE TABLE research_backtest_parts (
 run_id TEXT NOT NULL REFERENCES research_backtest_runs(id),
 kind TEXT NOT NULL CHECK(kind IN ('input','result')),
 part INTEGER NOT NULL,
 value_json TEXT NOT NULL,
 PRIMARY KEY(run_id,kind,part)
);
