CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  institution TEXT,
  type TEXT NOT NULL CHECK(type IN ('chequing','savings','credit','prepaid','cash','investment')),
  kind TEXT NOT NULL CHECK(kind IN ('asset','liability')),
  currency TEXT NOT NULL DEFAULT 'CAD',
  last4 TEXT,
  opening_balance_cents INTEGER NOT NULL DEFAULT 0,
  opening_balance_date TEXT,
  color TEXT NOT NULL DEFAULT '#4d6f9c',
  icon TEXT NOT NULL DEFAULT 'credit-card',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK(type IN ('income','expense')),
  color TEXT NOT NULL,
  icon TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_system INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  file_name TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  spec_id INTEGER,
  row_count INTEGER NOT NULL,
  inserted_count INTEGER NOT NULL,
  skipped_dupes INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('committed','undone')),
  source TEXT NOT NULL DEFAULT 'web' CHECK(source IN ('web','mcp')),
  statement_start_date TEXT,
  statement_end_date TEXT,
  statement_balance_cents INTEGER,
  computed_balance_cents INTEGER,
  reconciliation_status TEXT NOT NULL DEFAULT 'not_checked'
    CHECK(reconciliation_status IN ('not_checked','matched','mismatch')),
  validation_status TEXT NOT NULL DEFAULT 'not_checked'
    CHECK(validation_status IN ('not_checked','passed','failed')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  posted_date TEXT NOT NULL,
  description_raw TEXT NOT NULL,
  merchant_norm TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  category_source TEXT CHECK(category_source IN ('rule','ai','user')),
  is_transfer INTEGER NOT NULL DEFAULT 0,
  transfer_peer_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  import_id INTEGER REFERENCES imports(id) ON DELETE SET NULL,
  fingerprint TEXT NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(account_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_txn_acct_date ON transactions(account_id, posted_date DESC);
CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(posted_date DESC);
CREATE INDEX IF NOT EXISTS idx_txn_cat ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_txn_import ON transactions(import_id);

CREATE TABLE IF NOT EXISTS import_specs (
  id INTEGER PRIMARY KEY,
  format_fingerprint TEXT NOT NULL UNIQUE,
  bank_guess TEXT,
  spec_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('ai','user')),
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS merchant_rules (
  id INTEGER PRIMARY KEY,
  pattern TEXT NOT NULL,
  match_type TEXT NOT NULL DEFAULT 'exact' CHECK(match_type IN ('exact','prefix','contains')),
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK(source IN ('ai','user')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(pattern, match_type)
);

-- Periodic balance snapshots. For investment/retirement accounts (Wealthsimple,
-- IBKR, RRSP/TFSA) the market value moves without transactions, so the balance
-- is anchored on the latest snapshot instead of a transaction ledger. Works for
-- any account as a reconciliation anchor: balance = latest snapshot + Σ
-- transactions after the snapshot date.
CREATE TABLE IF NOT EXISTS balance_snapshots (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  snapshot_date TEXT NOT NULL,
  balance_cents INTEGER NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(account_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_acct_date ON balance_snapshots(account_id, snapshot_date DESC);

CREATE TABLE IF NOT EXISTS fx_rates (
  currency TEXT PRIMARY KEY,
  rate_to_cad REAL NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
