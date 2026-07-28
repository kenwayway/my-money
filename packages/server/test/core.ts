import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "my-money-core-"));
const sourcePath = path.join(scratchDir, "source.db");
const restoredPath = path.join(scratchDir, "restored.db");
process.env.MY_MONEY_DB = sourcePath;

const { db, initDb } = await import("../src/db/connection.js");
const { seedDb } = await import("../src/db/seed.js");
const { createDatabaseBackup } = await import("../src/db/backup.js");

initDb();
seedDb();
db.prepare(
  `INSERT INTO accounts
   (name, type, kind, currency, opening_balance_cents)
   VALUES ('Backup Test', 'chequing', 'asset', 'CAD', 12345)`
).run();

const backup = createDatabaseBackup();
assert.equal(Buffer.from(backup.bytes.subarray(0, 16)).toString("ascii"), "SQLite format 3\u0000");
fs.writeFileSync(restoredPath, backup.bytes);

const restored = new DatabaseSync(restoredPath, { readOnly: true });
const account = restored.prepare("SELECT name, opening_balance_cents FROM accounts").get() as {
  name: string;
  opening_balance_cents: number;
};
assert.deepEqual(account, { name: "Backup Test", opening_balance_cents: 12345 });
restored.close();
db.close();
fs.rmSync(scratchDir, { recursive: true, force: true });

console.log("Core tests OK — WAL-safe standalone backup");
