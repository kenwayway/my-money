import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { format } from "date-fns";
import { db } from "./connection.js";

export interface DatabaseBackup {
  fileName: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/**
 * Produce a transactionally consistent standalone SQLite file.
 *
 * Copying money.db directly while WAL mode is active can omit committed pages
 * that still live in money.db-wal. VACUUM INTO reads a consistent snapshot and
 * writes a self-contained database that is safe to restore by itself.
 */
export function createDatabaseBackup(): DatabaseBackup {
  const fileName = `my-money-${format(new Date(), "yyyyMMdd-HHmmss")}.db`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "my-money-backup-"));
  const outputPath = path.join(tempDir, fileName);

  try {
    // The path is generated locally, not supplied by a request. Escape it as a
    // SQLite string literal anyway so unusual Windows temp paths remain safe.
    const sqlitePath = outputPath.replace(/\\/g, "/").replace(/'/g, "''");
    db.exec(`VACUUM INTO '${sqlitePath}'`);
    const file = fs.readFileSync(outputPath);
    const bytes = new Uint8Array(new ArrayBuffer(file.byteLength));
    bytes.set(file);
    return { fileName, bytes };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
