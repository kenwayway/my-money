import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { monthCoverage, statementCycleCoverage } from "@my-money/shared";

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "my-money-core-"));
const sourcePath = path.join(scratchDir, "source.db");
const restoredPath = path.join(scratchDir, "restored.db");
const statementsPath = path.join(scratchDir, "statements");
process.env.MY_MONEY_DB = sourcePath;
process.env.MY_MONEY_STATEMENTS_DIR = statementsPath;
const legacyPdfSha = "a".repeat(64);
const legacyPdfBytes = Buffer.from("%PDF-1.4\nlegacy stored original\n%%EOF");
fs.mkdirSync(statementsPath, { recursive: true });
fs.writeFileSync(path.join(statementsPath, `${legacyPdfSha}.pdf`), legacyPdfBytes);

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

  CREATE TABLE statement_documents (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    import_id INTEGER UNIQUE REFERENCES imports(id) ON DELETE SET NULL,
    original_name TEXT NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    file_sha256 TEXT NOT NULL UNIQUE,
    size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
    mime_type TEXT NOT NULL DEFAULT 'application/pdf',
    uploaded_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  INSERT INTO statement_documents
    (account_id, original_name, storage_key, file_sha256, size_bytes, mime_type)
  VALUES (1, 'legacy.pdf', '${legacyPdfSha}', '${legacyPdfSha}',
          ${legacyPdfBytes.byteLength}, 'application/pdf');
`);
legacy.close();

const { db, initDb } = await import("../src/db/connection.js");
const { seedDb } = await import("../src/db/seed.js");
const { createDatabaseBackup, createFullBackupArchive } = await import("../src/db/backup.js");
const { financialInbox } = await import("../src/services/inbox.js");
const { pairRefund, refundCandidates, unpairRefund } = await import("../src/services/refunds.js");
const { monthlySpendingByCategory } = await import("../src/services/spending.js");
const { summaryRoute } = await import("../src/routes/summary.js");
const {
  MAX_STATEMENT_FILE_BYTES,
  StatementDocumentError,
  createStatementDocument,
  readStatementDocument,
  statementDocumentById,
} = await import("../src/services/statement-documents.js");
const { statementDocumentsRoute } = await import("../src/routes/statement-documents.js");
const { accountsRoute } = await import("../src/routes/accounts.js");
const unzipper = await import("unzipper");
const {
  listStatements,
  reconcileStatement,
  statementDetail,
  updateStatementPeriod,
} = await import("../src/services/statements.js");

initDb();
seedDb();
assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 7);
const migratedLegacyDocument = statementDocumentById(1)!;
assert.equal(migratedLegacyDocument.original_name, "legacy.pdf");
assert.equal(migratedLegacyDocument.account_id, 1);
assert.deepEqual(readStatementDocument(1).bytes, legacyPdfBytes);
assert.deepEqual(
  monthCoverage("2026-06", [{ start: "2026-06-15", end: "2026-07-14" }]),
  { coveredDays: 16, totalDays: 30, status: "partial" }
);
assert.deepEqual(
  monthCoverage("2026-06", [
    { start: "2026-06-01", end: "2026-06-14" },
    { start: "2026-06-15", end: "2026-07-14" },
  ]),
  { coveredDays: 30, totalDays: 30, status: "full" },
  "adjacent cross-month statement periods should merge into full calendar-month coverage"
);
assert.deepEqual(
  monthCoverage("2026-07", [
    { start: "2026-06-15", end: "2026-07-14" },
    { start: "2026-07-01", end: "2026-07-20" },
  ]),
  { coveredDays: 20, totalDays: 31, status: "partial" },
  "overlapping statements must not double-count days"
);
assert.deepEqual(
  statementCycleCoverage("2026-07", [
    { start: "2026-06-15", end: "2026-07-13" },
  ]),
  {
    coveredDays: 13,
    totalDays: 31,
    status: "full",
    hasPrimaryStatement: true,
  },
  "the period end month is a complete statement cycle, not a partial statement"
);
assert.deepEqual(
  statementCycleCoverage("2026-06", [
    { start: "2026-06-15", end: "2026-07-13" },
  ]),
  {
    coveredDays: 16,
    totalDays: 30,
    status: "partial",
    hasPrimaryStatement: false,
  },
  "cross-month carry-over should remain visible as partial calendar coverage"
);
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

const rentCategory = db.prepare("SELECT id FROM categories WHERE name = 'Rent'").get() as { id: number };
const rentExpense = db.prepare(
  `INSERT INTO transactions
   (account_id, posted_date, description_raw, merchant_norm, amount_cents, category_id, category_source, fingerprint)
   VALUES (?, '2026-07-31', 'MONTHLY RENT', 'MONTHLY RENT', -200000, ?, 'user', 'core-rent')`
).run(chequing.lastInsertRowid, rentCategory.id);
const roommateRefund = db.prepare(
  `INSERT INTO transactions
   (account_id, posted_date, description_raw, merchant_norm, amount_cents, fingerprint)
   VALUES (?, '2026-08-02', 'ROOMMATE RENT SHARE', 'ROOMMATE RENT SHARE', 100000, 'core-rent-refund')`
).run(chequing.lastInsertRowid);

assert.equal(
  refundCandidates(Number(roommateRefund.lastInsertRowid))[0]?.id,
  Number(rentExpense.lastInsertRowid),
  "a same-currency expense large enough for the refund should be suggested"
);
pairRefund(Number(rentExpense.lastInsertRowid), Number(roommateRefund.lastInsertRowid));
const pairedRows = db.prepare(
  "SELECT id, refund_peer_id FROM transactions WHERE id IN (?, ?) ORDER BY id"
).all(rentExpense.lastInsertRowid, roommateRefund.lastInsertRowid) as unknown as {
  id: number;
  refund_peer_id: number;
}[];
assert.equal(pairedRows[0]?.refund_peer_id, pairedRows[1]?.id);
assert.equal(pairedRows[1]?.refund_peer_id, pairedRows[0]?.id);
assert.equal(
  monthlySpendingByCategory("2026-07").find((row) => row.category_name === "Rent")?.total_cad_cents,
  100000,
  "a cross-month partial refund should reduce the original month's category spend"
);
assert.equal(
  financialInbox().uncategorized_count,
  0,
  "a linked positive refund should not remain in the uncategorized inbox"
);
const augustSummaryResponse = await summaryRoute.request("/spending?month=2026-08");
const augustSummary = await augustSummaryResponse.json() as {
  trend: { month: string; income_cad_cents: number }[];
};
assert.equal(
  augustSummary.trend.find((row) => row.month === "2026-08")?.income_cad_cents,
  0,
  "a linked refund should not count as income in its posted month"
);
assert.throws(
  () => pairRefund(Number(rentExpense.lastInsertRowid), Number(rentExpense.lastInsertRowid)),
  /itself/
);
unpairRefund(Number(roommateRefund.lastInsertRowid));
assert.equal(
  monthlySpendingByCategory("2026-07").find((row) => row.category_name === "Rent")?.total_cad_cents,
  200000,
  "unlinking should restore the original expense"
);
pairRefund(Number(rentExpense.lastInsertRowid), Number(roommateRefund.lastInsertRowid));

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
const periodUpdated = updateStatementPeriod(
  Number(statementImport.lastInsertRowid),
  "2026-06-15",
  "2026-07-01"
);
assert.equal(periodUpdated.statement_start_date, "2026-06-15");
assert.equal(periodUpdated.statement_end_date, "2026-07-01");
assert.equal(
  periodUpdated.reconciliation_status,
  "matched",
  "changing a period must recompute an existing balance check"
);
assert.throws(
  () =>
    updateStatementPeriod(
      Number(statementImport.lastInsertRowid),
      "2026-07-02",
      "2026-07-31"
    ),
  /earliest transaction/,
  "a manually edited period must still contain all imported transactions"
);

const attachmentBytes = Buffer.from("%PDF-1.7\nhistorical original\n%%EOF");
const attachmentForm = new FormData();
attachmentForm.set("account_id", String(chequing.lastInsertRowid));
attachmentForm.set("import_id", String(statementImport.lastInsertRowid));
attachmentForm.set(
  "file",
  new File([attachmentBytes], "historical-july.pdf", { type: "application/pdf" })
);
const attachmentResponse = await statementDocumentsRoute.request("/", {
  method: "POST",
  body: attachmentForm,
});
assert.equal(attachmentResponse.status, 201);
const attachment = await attachmentResponse.json() as {
  id: number;
  import_id: number;
  processing_status: string;
};
assert.equal(attachment.import_id, Number(statementImport.lastInsertRowid));
assert.equal(attachment.processing_status, "processed");
const attachedDetail = statementDetail(Number(statementImport.lastInsertRowid))!;
assert.equal(attachedDetail.statement.document_id, attachment.id);
assert.equal(attachedDetail.statement.document_name, "historical-july.pdf");
assert.equal(attachedDetail.transactions.length, 1, "attaching a PDF must not change transactions");
assert.equal(attachedDetail.statement.reconciliation_status, "matched");

const secondAttachmentForm = new FormData();
secondAttachmentForm.set("account_id", String(chequing.lastInsertRowid));
secondAttachmentForm.set("import_id", String(statementImport.lastInsertRowid));
secondAttachmentForm.set(
  "file",
  new File(
    [Buffer.from("%PDF-1.7\nsecond historical original\n%%EOF")],
    "second.pdf",
    { type: "application/pdf" }
  )
);
assert.equal(
  (await statementDocumentsRoute.request("/", {
    method: "POST",
    body: secondAttachmentForm,
  })).status,
  409,
  "one import must not accept two original PDFs"
);

const pdfAccount = db.prepare(
  `INSERT INTO accounts (name, type, kind, currency)
   VALUES ('PDF Only', 'savings', 'asset', 'CAD')`
).run();
const pdfBytes = Buffer.from("%PDF-1.7\nstatement inbox test\n%%EOF");
const form = new FormData();
form.set("account_id", String(pdfAccount.lastInsertRowid));
form.set("file", new File([pdfBytes], "../private/july-statement.pdf", { type: "application/pdf" }));
const uploadResponse = await statementDocumentsRoute.request("/", { method: "POST", body: form });
assert.equal(uploadResponse.status, 201);
const uploaded = await uploadResponse.json() as { id: number; original_name: string };
assert.equal(uploaded.original_name, "july-statement.pdf", "original name must be reduced to a basename");
const uploadedPath = path.join(statementsPath, `${statementDocumentById(uploaded.id)!.file_sha256}.pdf`);
assert.ok(fs.existsSync(uploadedPath));

const downloadResponse = await statementDocumentsRoute.request(`/${uploaded.id}/file`);
assert.equal(downloadResponse.status, 200);
assert.equal(downloadResponse.headers.get("content-type"), "application/pdf");
assert.match(downloadResponse.headers.get("content-disposition") ?? "", /^inline;/);
assert.deepEqual(Buffer.from(await downloadResponse.arrayBuffer()), pdfBytes);

const duplicateForm = new FormData();
duplicateForm.set("account_id", String(pdfAccount.lastInsertRowid));
duplicateForm.set("file", new File([pdfBytes], "duplicate.pdf", { type: "application/pdf" }));
assert.equal(
  (await statementDocumentsRoute.request("/", { method: "POST", body: duplicateForm })).status,
  409,
  "identical PDF content must be rejected globally"
);
assert.throws(
  () => createStatementDocument(Number(pdfAccount.lastInsertRowid), "fake.pdf", Buffer.from("not a pdf")),
  (error: unknown) => error instanceof StatementDocumentError && error.status === 400
);
assert.throws(
  () =>
    createStatementDocument(
      Number(pdfAccount.lastInsertRowid),
      "huge.pdf",
      Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(MAX_STATEMENT_FILE_BYTES)])
    ),
  (error: unknown) => error instanceof StatementDocumentError && error.status === 413
);

const csvBytes = Buffer.from("Date,Description,Amount\n2026-07-01,Coffee,-4.25\n");
const csvForm = new FormData();
csvForm.set("file", new File([csvBytes], "unassigned.csv", { type: "text/csv" }));
const csvResponse = await statementDocumentsRoute.request("/", {
  method: "POST",
  body: csvForm,
});
assert.equal(csvResponse.status, 201);
const csvDocument = await csvResponse.json() as {
  id: number;
  account_id: number | null;
  mime_type: string;
  file_sha256: string;
};
assert.equal(csvDocument.account_id, null, "new Inbox files should not require an account");
assert.equal(csvDocument.mime_type, "text/csv");
const csvDownload = await statementDocumentsRoute.request(`/${csvDocument.id}/file`);
assert.equal(csvDownload.headers.get("content-type"), "text/csv");
assert.deepEqual(Buffer.from(await csvDownload.arrayBuffer()), csvBytes);

const accountDelete = await accountsRoute.request(`/${pdfAccount.lastInsertRowid}`, { method: "DELETE" });
assert.equal((await accountDelete.json() as { archived: boolean }).archived, true);

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

const fullBackup = await createFullBackupArchive();
try {
  const zip = await unzipper.Open.file(fullBackup.filePath);
  const names = zip.files.map((entry) => entry.path);
  assert.ok(names.includes("money.db"));
  assert.ok(names.includes("RESTORE.txt"));
  assert.ok(names.some((name) => name === `statements/${statementDocumentById(uploaded.id)!.file_sha256}.pdf`));
  assert.ok(names.includes(`statements/${csvDocument.file_sha256}.csv`));
  const dbEntry = zip.files.find((entry) => entry.path === "money.db")!;
  const restoredBytes = await dbEntry.buffer();
  assert.equal(restoredBytes.subarray(0, 16).toString("ascii"), "SQLite format 3\u0000");
} finally {
  fullBackup.cleanup();
}

const deleteResponse = await statementDocumentsRoute.request(`/${uploaded.id}`, { method: "DELETE" });
assert.equal(deleteResponse.status, 200);
assert.equal(statementDocumentById(uploaded.id), null);
assert.equal(fs.existsSync(uploadedPath), false);
assert.equal(
  (await statementDocumentsRoute.request(`/${csvDocument.id}`, { method: "DELETE" })).status,
  200
);

db.close();
fs.rmSync(scratchDir, { recursive: true, force: true });

console.log("Core tests OK — backup, financial inbox, and statement center");
