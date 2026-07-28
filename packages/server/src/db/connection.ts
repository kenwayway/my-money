import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// packages/server/src/db → repo root is 4 levels up
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const dataDir = path.join(repoRoot, "data");
fs.mkdirSync(dataDir, { recursive: true });

export const DB_PATH = process.env.MY_MONEY_DB ?? path.join(dataDir, "money.db");

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
// The web server and the MCP server share this DB; without a busy timeout a
// concurrent write from the other process throws SQLITE_BUSY immediately.
db.exec("PRAGMA busy_timeout = 5000;");

/** Run fn inside a transaction (BEGIN/COMMIT, ROLLBACK on throw). */
export function tx<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function initDb(): void {
  const schema = fs.readFileSync(path.join(here, "schema.sql"), "utf8");
  db.exec(schema);

  // Repair legacy/non-reciprocal links before enforcing one-to-one pairing.
  // A valid pair is always A → B and B → A; anything else is safer unpaired.
  db.exec(`
    UPDATE transactions
    SET transfer_peer_id = NULL, is_transfer = 0
    WHERE transfer_peer_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM transactions AS peer
        WHERE peer.id = transactions.transfer_peer_id
          AND peer.transfer_peer_id = transactions.id
      );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_txn_transfer_peer_unique
      ON transactions(transfer_peer_id)
      WHERE transfer_peer_id IS NOT NULL;
  `);
}
