-- Additional private accounts. Existing environment-managed accounts and
-- sessions remain intact; no real account or credential is seeded.
CREATE TABLE research_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
  last_change_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE research_user_sessions (
  token_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES research_users(id),
  user_revision INTEGER NOT NULL
);
CREATE INDEX research_user_sessions_user ON research_user_sessions(user_id);
CREATE TABLE user_account_audit (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES research_users(id),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  previous_value TEXT,
  new_value TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX user_account_audit_user ON user_account_audit(user_id,created_at);
