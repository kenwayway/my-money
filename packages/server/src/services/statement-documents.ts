import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StatementDocument } from "@my-money/shared";
import { DB_PATH, db } from "../db/connection.js";

export const MAX_STATEMENT_FILE_BYTES = 20 * 1024 * 1024;
export const STATEMENTS_DIR =
  process.env.MY_MONEY_STATEMENTS_DIR ?? path.join(path.dirname(DB_PATH), "statements");

export class StatementDocumentError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 | 413
  ) {
    super(message);
  }
}

let storageQueue: Promise<void> = Promise.resolve();

export async function withStatementStorageLock<T>(work: () => Promise<T> | T): Promise<T> {
  const previous = storageQueue;
  let release!: () => void;
  storageQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

function cleanOriginalName(name: string): string {
  const base = path
    .basename(name.replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return base || "statement.pdf";
}

function documentPath(
  storageKey: string,
  mimeType: StatementDocument["mime_type"]
): string {
  if (!/^[a-f0-9]{64}$/.test(storageKey)) {
    throw new Error("invalid statement document storage key");
  }
  const extension = mimeType === "application/pdf" ? "pdf" : "csv";
  return path.join(STATEMENTS_DIR, `${storageKey}.${extension}`);
}

const DOCUMENT_SELECT = `
  SELECT d.id, d.account_id, a.name AS account_name, a.currency AS account_currency,
         a.color AS account_color, d.import_id, i.status AS import_status,
         d.original_name, d.file_sha256, d.size_bytes, d.mime_type, d.uploaded_at,
         CASE
           WHEN d.import_id IS NULL THEN 'pending'
           WHEN i.status = 'committed' THEN 'processed'
           ELSE 'undone'
         END AS processing_status
  FROM statement_documents d
  LEFT JOIN accounts a ON a.id = d.account_id
  LEFT JOIN imports i ON i.id = d.import_id
`;

function withResourceUri(
  row: Omit<StatementDocument, "resource_uri">
): StatementDocument {
  return { ...row, resource_uri: `statement://documents/${row.id}` };
}

export function listStatementDocuments(
  filter: "pending" | "all" = "pending"
): StatementDocument[] {
  const where =
    filter === "pending"
      ? "WHERE d.import_id IS NULL OR i.status = 'undone'"
      : "";
  const rows = db
    .prepare(`${DOCUMENT_SELECT} ${where} ORDER BY d.uploaded_at DESC, d.id DESC`)
    .all() as unknown as Omit<StatementDocument, "resource_uri">[];
  return rows.map(withResourceUri);
}

export function statementDocumentById(id: number): StatementDocument | null {
  const row = db
    .prepare(`${DOCUMENT_SELECT} WHERE d.id = ?`)
    .get(id) as unknown as Omit<StatementDocument, "resource_uri"> | undefined;
  return row ? withResourceUri(row) : null;
}

export function readStatementDocument(id: number): {
  document: StatementDocument;
  bytes: Buffer;
} {
  const document = statementDocumentById(id);
  if (!document) throw new StatementDocumentError("statement document not found", 404);
  const storage = db
    .prepare("SELECT storage_key, mime_type FROM statement_documents WHERE id = ?")
    .get(id) as {
    storage_key: string;
    mime_type: StatementDocument["mime_type"];
  };
  try {
    return {
      document,
      bytes: fs.readFileSync(
        documentPath(storage.storage_key, storage.mime_type)
      ),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new StatementDocumentError("stored statement file is missing", 404);
    }
    throw error;
  }
}

export function createStatementDocument(
  accountId: number | null,
  originalName: string,
  bytes: Uint8Array,
  importId?: number
): StatementDocument {
  let resolvedAccountId = accountId;
  if (importId !== undefined) {
    const target = db
      .prepare(
        `SELECT i.id, i.account_id, d.id AS document_id
         FROM imports i
         LEFT JOIN statement_documents d ON d.import_id = i.id
         WHERE i.id = ?`
      )
      .get(importId) as
      | { id: number; account_id: number; document_id: number | null }
      | undefined;
    if (!target) throw new StatementDocumentError("statement import not found", 404);
    if (accountId !== null && target.account_id !== accountId) {
      throw new StatementDocumentError(
        "statement import does not belong to the selected account",
        400
      );
    }
    resolvedAccountId = target.account_id;
    if (target.document_id !== null) {
      throw new StatementDocumentError(
        `statement import already has document #${target.document_id}`,
        409
      );
    }
  } else if (accountId !== null) {
    const account = db
      .prepare("SELECT id FROM accounts WHERE id = ? AND archived = 0")
      .get(accountId);
    if (!account) {
      throw new StatementDocumentError("active account not found", 400);
    }
  }
  if (bytes.byteLength === 0) {
    throw new StatementDocumentError("statement file is empty", 400);
  }
  if (bytes.byteLength > MAX_STATEMENT_FILE_BYTES) {
    throw new StatementDocumentError("statement file exceeds the 20 MiB limit", 413);
  }

  const cleanedName = cleanOriginalName(originalName);
  const prefix = Buffer.from(bytes.subarray(0, 5)).toString("ascii");
  let mimeType: StatementDocument["mime_type"];
  if (prefix === "%PDF-") {
    mimeType = "application/pdf";
  } else {
    if (path.extname(cleanedName).toLowerCase() !== ".csv") {
      throw new StatementDocumentError("file must be a valid PDF or CSV", 400);
    }
    const buffer = Buffer.from(bytes);
    if (buffer.includes(0)) {
      throw new StatementDocumentError("CSV contains binary data", 400);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new StatementDocumentError("CSV must use UTF-8 encoding", 400);
    }
    if (!/[,\t;]/.test(text)) {
      throw new StatementDocumentError(
        "CSV must contain comma, tab, or semicolon-separated fields",
        400
      );
    }
    mimeType = "text/csv";
  }

  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const duplicate = db
    .prepare("SELECT id FROM statement_documents WHERE file_sha256 = ?")
    .get(sha256) as { id: number } | undefined;
  if (duplicate) {
    throw new StatementDocumentError(
      `this statement file is already stored as document #${duplicate.id}`,
      409
    );
  }

  fs.mkdirSync(STATEMENTS_DIR, { recursive: true });
  const finalPath = documentPath(sha256, mimeType);
  const tempPath = path.join(
    STATEMENTS_DIR,
    `.${sha256}.${crypto.randomBytes(8).toString("hex")}.tmp`
  );
  let createdFile = false;
  try {
    fs.writeFileSync(tempPath, bytes, { flag: "wx" });
    if (fs.existsSync(finalPath)) {
      fs.rmSync(tempPath, { force: true });
    } else {
      fs.renameSync(tempPath, finalPath);
      createdFile = true;
    }
    const result = db
      .prepare(
        `INSERT INTO statement_documents
         (account_id, import_id, original_name, storage_key, file_sha256, size_bytes, mime_type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        resolvedAccountId,
        importId ?? null,
        cleanedName,
        sha256,
        sha256,
        bytes.byteLength,
        mimeType
      );
    return statementDocumentById(Number(result.lastInsertRowid))!;
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
      if (createdFile) fs.rmSync(finalPath, { force: true });
    } catch {
      // Preserve the original failure.
    }
    if (
      error instanceof Error &&
      /UNIQUE constraint failed: statement_documents\.(file_sha256|storage_key)/.test(
        error.message
      )
    ) {
      throw new StatementDocumentError("this statement file is already stored", 409);
    }
    if (
      error instanceof Error &&
      /UNIQUE constraint failed: statement_documents\.import_id/.test(error.message)
    ) {
      throw new StatementDocumentError("statement import already has a PDF", 409);
    }
    throw error;
  }
}

export function deleteStatementDocument(id: number): StatementDocument {
  const document = statementDocumentById(id);
  if (!document) throw new StatementDocumentError("statement document not found", 404);
  const storage = db
    .prepare("SELECT storage_key, mime_type FROM statement_documents WHERE id = ?")
    .get(id) as {
    storage_key: string;
    mime_type: StatementDocument["mime_type"];
  };
  const filePath = documentPath(storage.storage_key, storage.mime_type);
  const quarantinePath = `${filePath}.${crypto.randomBytes(8).toString("hex")}.deleting`;
  let moved = false;
  try {
    if (fs.existsSync(filePath)) {
      fs.renameSync(filePath, quarantinePath);
      moved = true;
    }
    db.prepare("DELETE FROM statement_documents WHERE id = ?").run(id);
    if (moved) fs.rmSync(quarantinePath, { force: true });
    return document;
  } catch (error) {
    if (moved && fs.existsSync(quarantinePath)) {
      fs.renameSync(quarantinePath, filePath);
    }
    throw error;
  }
}

export function statementDocumentStorageEntries(): {
  archiveName: string;
  filePath: string;
}[] {
  const rows = db
    .prepare("SELECT storage_key, mime_type FROM statement_documents ORDER BY id")
    .all() as {
    storage_key: string;
    mime_type: StatementDocument["mime_type"];
  }[];
  return rows.map((row) => ({
    archiveName: `statements/${row.storage_key}.${row.mime_type === "application/pdf" ? "pdf" : "csv"}`,
    filePath: documentPath(row.storage_key, row.mime_type),
  }));
}
