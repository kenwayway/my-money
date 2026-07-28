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
  migrateDb();

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

function hasColumn(table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((row) => row.name === column);
}

/** Ordered, idempotent migrations for existing local databases. */
function migrateDb(): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version < 1) {
    tx(() => {
      const columns: [string, string][] = [
        ["source", "TEXT NOT NULL DEFAULT 'web' CHECK(source IN ('web','mcp'))"],
        ["statement_start_date", "TEXT"],
        ["statement_end_date", "TEXT"],
        ["statement_balance_cents", "INTEGER"],
        ["computed_balance_cents", "INTEGER"],
        [
          "reconciliation_status",
          "TEXT NOT NULL DEFAULT 'not_checked' CHECK(reconciliation_status IN ('not_checked','matched','mismatch'))",
        ],
        [
          "validation_status",
          "TEXT NOT NULL DEFAULT 'not_checked' CHECK(validation_status IN ('not_checked','passed','failed'))",
        ],
      ];
      for (const [name, definition] of columns) {
        if (!hasColumn("imports", name)) db.exec(`ALTER TABLE imports ADD COLUMN ${name} ${definition}`);
      }

      // Older batches did not persist their statement period. Recover it from
      // the transactions that still belong to the batch whenever possible.
      db.exec(`
        UPDATE imports
        SET statement_start_date = (
              SELECT MIN(posted_date) FROM transactions WHERE import_id = imports.id
            ),
            statement_end_date = (
              SELECT MAX(posted_date) FROM transactions WHERE import_id = imports.id
            )
        WHERE statement_start_date IS NULL OR statement_end_date IS NULL;

        UPDATE imports
        SET source = 'mcp'
        WHERE spec_id IS NULL;

        PRAGMA user_version = 1;
      `);
    });
  }

  if (version < 2) {
    tx(() => {
      // Replace only the two historical default purples. Any color the user
      // explicitly chose remains untouched.
      db.exec(`
        UPDATE accounts
        SET color = CASE type
          WHEN 'chequing' THEN '#2f8168'
          WHEN 'savings' THEN '#a77a28'
          WHEN 'credit' THEN '#b96350'
          WHEN 'prepaid' THEN '#527c9d'
          WHEN 'cash' THEN '#766f64'
          WHEN 'investment' THEN '#65784e'
          ELSE color
        END
        WHERE lower(color) IN ('#6366f1', '#4f46e5');

        PRAGMA user_version = 2;
      `);
    });
  }

  if (version < 3) {
    tx(() => {
      // Account colors are decorative, not status indicators. Move the
      // previous success/warning/error-like defaults to a muted neutral set.
      db.exec(`
        UPDATE accounts
        SET color = CASE type
          WHEN 'chequing' THEN '#687b8a'
          WHEN 'savings' THEN '#8a7d6b'
          WHEN 'credit' THEN '#7d7582'
          WHEN 'prepaid' THEN '#718486'
          WHEN 'cash' THEN '#807970'
          WHEN 'investment' THEN '#747d76'
          ELSE color
        END
        WHERE (type = 'chequing' AND lower(color) = '#2f8168')
           OR (type = 'savings' AND lower(color) = '#a77a28')
           OR (type = 'credit' AND lower(color) = '#b96350')
           OR (type = 'prepaid' AND lower(color) = '#527c9d')
           OR (type = 'cash' AND lower(color) = '#766f64')
           OR (type = 'investment' AND lower(color) = '#65784e');

        PRAGMA user_version = 3;
      `);
    });
  }

  if (version < 4) {
    tx(() => {
      // Keep account colors distinct without borrowing the app's green,
      // amber, and red status language.
      db.exec(`
        UPDATE accounts
        SET color = CASE type
          WHEN 'chequing' THEN '#4d6f9c'
          WHEN 'savings' THEN '#3f7f86'
          WHEN 'credit' THEN '#8a5e80'
          ELSE color
        END
        WHERE (type = 'chequing' AND lower(color) = '#687b8a')
           OR (type = 'savings' AND lower(color) = '#8a7d6b')
           OR (type = 'credit' AND lower(color) = '#7d7582');

        PRAGMA user_version = 4;
      `);
    });
  }
}
