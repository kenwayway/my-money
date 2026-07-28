import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "my-money-core-"));
const sourcePath = path.join(scratchDir, "source.db");
const restoredPath = path.join(scratchDir, "restored.db");
process.env.MY_MONEY_DB = sourcePath;

// Start from the pre-Statement-Center imports shape to exercise the real
// ALTER TABLE migration, not only a fresh-schema install.
const legacy = new DatabaseSync(sourcePath);
legacy.exec(`
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    institution TEXT,
    type TEXT NOT NULL,
    kind TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'CAD',
    last4 TEXT,
    opening_balance_cents INTEGER NOT NULL DEFAULT 0,
    opening_balance_date TEXT,
    color TEXT NOT NULL DEFAULT '#6366f1',
    icon TEXT NOT NULL DEFAULT 'credit-card',
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  INSERT INTO accounts (name, type, kind, color)
  VALUES ('Legacy Purple Card', 'credit', 'liability', '#6366f1');

  CREATE TABLE imports (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL,
    file_name TEXT NOT NULL,
    file_sha256 TEXT NOT NULL,
    spec_id INTEGER,
    row_count INTEGER NOT NULL,
    inserted_count INTEGER NOT NULL,
    skipped_dupes INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);
legacy.close();

const { db, initDb } = await import("../src/db/connection.js");
const { seedDb } = await import("../src/db/seed.js");
const { createDatabaseBackup } = await import("../src/db/backup.js");
const { financialInbox } = await import("../src/services/inbox.js");
const {
  listStatements,
  reconcileStatement,
  statementDetail,
} = await import("../src/services/statements.js");

initDb();
seedDb();
assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 4);
assert.equal(
  (db.prepare("SELECT color FROM accounts WHERE name = 'Legacy Purple Card'").get() as { color: string }).color,
  "#8a5e80",
  "legacy default purple should migrate to the account type color"
);
const chequing = db.prepare(
  `INSERT INTO accounts
   (name, type, kind, currency, opening_balance_cents)
   VALUES ('Backup Test', 'chequing', 'asset', 'CAD', 12345)`
).run();
const investment = db.prepare(
  `INSERT INTO accounts
   (name, type, kind, currency, opening_balance_cents)
   VALUES ('TFSA', 'investment', 'asset', 'USD', 0)`
).run();
db.prepare(
  `INSERT INTO transactions
   (account_id, posted_date, description_raw, merchant_norm, amount_cents, fingerprint)
   VALUES (?, '2026-07-01', 'UNKNOWN SHOP', 'UNKNOWN SHOP', -2500, 'core-uncategorized')`
).run(chequing.lastInsertRowid);

const inbox = financialInbox();
assert.equal(inbox.uncategorized_count, 1);
assert.deepEqual(inbox.missing_fx_currencies, ["USD"]);
assert.equal(inbox.stale_investment_accounts.length, 1);
assert.equal(inbox.stale_investment_accounts[0]?.account_name, "TFSA");
assert.equal(inbox.attention_group_count, 3);

const otherCategory = db.prepare("SELECT id FROM categories WHERE name = 'Other'").get() as { id: number };
db.prepare("UPDATE transactions SET category_id = ?, category_source = 'user'").run(otherCategory.id);
db.prepare("INSERT INTO fx_rates (currency, rate_to_cad) VALUES ('USD', 1.37)").run();
db.prepare(
  `INSERT INTO balance_snapshots (account_id, snapshot_date, balance_cents)
   VALUES (?, '2099-01-01', 500000)`
).run(investment.lastInsertRowid);
assert.equal(financialInbox().attention_group_count, 0, "resolved inbox work should disappear");

const statementImport = db.prepare(
  `INSERT INTO imports
   (account_id, file_name, file_sha256, row_count, inserted_count, skipped_dupes, status,
    source, statement_start_date, statement_end_date, validation_status)
   VALUES (?, 'july.csv', 'core-statement', 1, 1, 0, 'committed',
           'web', '2026-07-01', '2026-07-01', 'passed')`
).run(chequing.lastInsertRowid);
db.prepare("UPDATE transactions SET import_id = ? WHERE fingerprint = 'core-uncategorized'").run(
  statementImport.lastInsertRowid
);
assert.equal(listStatements().length, 1);
assert.equal(financialInbox().unreconciled_statement_count, 1);
const reconciled = reconcileStatement(Number(statementImport.lastInsertRowid), "2026-07-01", 9845);
assert.equal(reconciled.reconciliation_status, "matched");
assert.equal(reconciled.difference_cents, 0);
assert.equal(statementDetail(reconciled.id)?.transactions.length, 1);
assert.equal(financialInbox().attention_group_count, 0, "reconciled statements should leave the inbox");

const backup = createDatabaseBackup();
assert.equal(Buffer.from(backup.bytes.subarray(0, 16)).toString("ascii"), "SQLite format 3\u0000");
fs.writeFileSync(restoredPath, backup.bytes);

const restored = new DatabaseSync(restoredPath, { readOnly: true });
const account = restored.prepare("SELECT name, opening_balance_cents FROM accounts WHERE name = 'Backup Test'").get() as {
  name: string;
  opening_balance_cents: number;
};
assert.deepEqual(account, { name: "Backup Test", opening_balance_cents: 12345 });
restored.close();
db.close();
fs.rmSync(scratchDir, { recursive: true, force: true });

console.log("Core tests OK — backup, financial inbox, and statement center");
