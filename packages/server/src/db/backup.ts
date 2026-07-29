import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ZipArchive } from "archiver";
import { format } from "date-fns";
import { db } from "./connection.js";
import {
  statementDocumentStorageEntries,
  withStatementStorageLock,
} from "../services/statement-documents.js";

export interface DatabaseBackup {
  fileName: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export interface FullBackupArchive {
  fileName: string;
  filePath: string;
  sizeBytes: number;
  cleanup: () => void;
}

function createDatabaseSnapshot(outputPath: string): void {
  const sqlitePath = outputPath.replace(/\\/g, "/").replace(/'/g, "''");
  db.exec(`VACUUM INTO '${sqlitePath}'`);
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
    createDatabaseSnapshot(outputPath);
    const file = fs.readFileSync(outputPath);
    const bytes = new Uint8Array(new ArrayBuffer(file.byteLength));
    bytes.set(file);
    return { fileName, bytes };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Build a self-contained ZIP in a temporary directory. The ZIP is assembled
 * while uploads/deletes are locked, then can be streamed without holding the
 * lock because the completed archive is immutable.
 */
export async function createFullBackupArchive(): Promise<FullBackupArchive> {
  return withStatementStorageLock(async () => {
    const timestamp = format(new Date(), "yyyyMMdd-HHmmss");
    const fileName = `my-money-${timestamp}.zip`;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "my-money-full-backup-"));
    const snapshotPath = path.join(tempDir, "money.db");
    const archivePath = path.join(tempDir, fileName);

    try {
      createDatabaseSnapshot(snapshotPath);
      const documents = statementDocumentStorageEntries();
      for (const document of documents) {
        if (!fs.existsSync(document.filePath)) {
          throw new Error(`cannot back up missing PDF: ${document.archiveName}`);
        }
      }

      const output = fs.createWriteStream(archivePath);
      const zip = new ZipArchive({ zlib: { level: 9 } });
      await new Promise<void>((resolve, reject) => {
        output.on("close", resolve);
        output.on("error", reject);
        zip.on("error", reject);
        zip.pipe(output);
        zip.file(snapshotPath, { name: "money.db" });
        for (const document of documents) {
          zip.file(document.filePath, { name: document.archiveName });
        }
        zip.append(
          [
            "my-money full backup",
            "",
            "Contents:",
            "- money.db: consistent SQLite snapshot",
            "- statements/: original PDF/CSV statements named by SHA-256",
            "",
            "Restore:",
            "1. Stop both the my-money Web and MCP processes.",
            "2. Replace the active money.db with this money.db.",
            "3. Replace the sibling statements directory with this statements directory.",
            "4. Start my-money again.",
            "",
            "The database and statement files contain private financial information and are not encrypted.",
            "",
          ].join("\n"),
          { name: "RESTORE.txt" }
        );
        void zip.finalize();
      });

      return {
        fileName,
        filePath: archivePath,
        sizeBytes: fs.statSync(archivePath).size,
        cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
      };
    } catch (error) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      throw error;
    }
  });
}
