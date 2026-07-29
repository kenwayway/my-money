/**
 * End-to-end test of the MCP server over real stdio, against a throwaway DB.
 * Run: npm run test:mcp -w packages/server
 *
 * Covers the category-precedence invariant (user rule > AI suggestion > AI rule)
 * and statement-balance reconciliation.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "my-money-e2e-"));
const SCRATCH_DB = path.join(scratchDir, "e2e.db");
const SCRATCH_STATEMENTS = path.join(scratchDir, "statements");

// tsx may be hoisted to the repo root — resolve it the way node would
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [tsxCli, path.join(here, "..", "src", "mcp.ts")],
  env: {
    ...(process.env as Record<string, string>),
    MY_MONEY_DB: SCRATCH_DB,
    MY_MONEY_STATEMENTS_DIR: SCRATCH_STATEMENTS,
  },
});
const client = new Client({ name: "e2e-test", version: "0.0.0" });
await client.connect(transport);

const call = async (name: string, args: Record<string, unknown>) => {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { text: string }[];
    isError?: boolean;
  };
  const data = JSON.parse(res.content[0]!.text);
  if (res.isError) throw new Error(data.error);
  return data;
};

// account + first import: AI says PETSMART is Shopping → accepted, ai rule created
const acct = await call("create_account", { name: "Visa", type: "credit" });
assert.equal(acct.color, "#8a5e80", "MCP-created accounts should receive their type color");
const imp1 = await call("import_transactions", {
  account: acct.id,
  transactions: [{ date: "2026-07-01", description: "PETSMART #1234 HALIFAX NS", amount_cents: -5000, category: "Shopping" }],
});
assert.equal(imp1.inserted, 1);
let rows = await call("list_transactions", { account: acct.id });
assert.equal(rows[0].category, "Shopping");

// the user corrects the merchant → user rule
await call("set_category", { transaction_id: rows[0].id, category: "Groceries" });

// second import, same merchant, AI again says Shopping → the user rule must win
const imp2 = await call("import_transactions", {
  account: acct.id,
  transactions: [{ date: "2026-07-15", description: "PETSMART #1234 HALIFAX NS", amount_cents: -3000, category: "Shopping" }],
});
assert.equal(imp2.inserted, 1);
rows = await call("list_transactions", { account: acct.id });
const newest = rows.find((r: { posted_date: string }) => r.posted_date === "2026-07-15");
assert.equal(newest.category, "Groceries", `user rule should beat AI suggestion, got ${newest.category}`);

// a merchant with no user rule: the AI suggestion still applies
const imp3 = await call("import_transactions", {
  account: acct.id,
  transactions: [{ date: "2026-07-16", description: "UNIQLO RIDEAU", amount_cents: -2000, category: "Shopping" }],
});
assert.equal(imp3.inserted, 1);
rows = await call("list_transactions", { account: acct.id, search: "UNIQLO" });
assert.equal(rows[0].category, "Shopping");

// reconciliation: -5000 -3000 -2000 -100 = -10100 matches → ok.
const imp4 = await call("import_transactions", {
  account: acct.id,
  transactions: [{ date: "2026-07-20", description: "COFFEE", amount_cents: -100 }],
  statement_end_balance_cents: -10100,
});
assert.equal(imp4.balance_check.status, "ok");
const importHistory = await call("list_imports", {});
const reconciledImport = importHistory.find((i: { id: number }) => i.id === imp4.import_id);
assert.equal(reconciledImport.reconciliation_status, "matched");
assert.equal(reconciledImport.statement_end_date, "2026-07-20");

// A mismatch is rejected atomically by default: no transaction, import record,
// or learned merchant rule survives the rollback.
const imp5 = await call("import_transactions", {
  account: acct.id,
  transactions: [{ date: "2026-07-21", description: "TEA", amount_cents: -200, category: "Coffee" }],
  statement_end_balance_cents: -99999,
});
assert.equal(imp5.rejected, true);
assert.equal(imp5.balance_check.status, "mismatch");
rows = await call("list_transactions", { account: acct.id, search: "TEA" });
assert.equal(rows.length, 0, "rejected reconciliation must roll back the transaction");
const teaRetry = await call("import_transactions", {
  account: acct.id,
  transactions: [{ date: "2026-07-21", description: "TEA", amount_cents: -200 }],
});
rows = await call("list_transactions", { account: acct.id, search: "TEA" });
assert.equal(rows[0].category, null, "rejected reconciliation must roll back its learned AI rule");
await call("undo_import", { import_id: teaRetry.import_id });

// dedupe: re-importing an overlapping batch inserts nothing
const imp6 = await call("import_transactions", {
  account: acct.id,
  transactions: [{ date: "2026-07-16", description: "UNIQLO RIDEAU", amount_cents: -2000 }],
});
assert.equal(imp6.inserted, 0);
assert.equal(imp6.skipped_duplicates, 1);

// Missing FX fails closed instead of pretending USD == CAD.
const usd = await call("create_account", {
  name: "USD Savings",
  type: "savings",
  currency: "USD",
  opening_balance_cents: 10000,
});
let summary = await call("get_summary", {});
assert.equal(summary.net_worth_cad_cents, null);
assert.deepEqual(summary.missing_fx_currencies, ["USD"]);
await call("set_fx_rate", { currency: "USD", rate_to_cad: 1.37 });
summary = await call("get_summary", {});
assert.equal(summary.fx_complete, true);
const usdSummary = summary.accounts.find((a: { name: string }) => a.name === usd.name);
assert.equal(usdSummary.balance_cad_cents, 13700);

// Re-pairing dissolves the old reciprocal pair, and mismatched pairs require
// an explicit override.
const cheq = await call("create_account", { name: "Chequing", type: "chequing" });
await call("import_transactions", {
  account: acct.id,
  transactions: [{ date: "2026-08-01", description: "CARD PAYMENT", amount_cents: 1000 }],
});
await call("import_transactions", {
  account: cheq.id,
  transactions: [
    { date: "2026-08-01", description: "CARD PAYMENT OLD", amount_cents: -1000 },
    { date: "2026-08-02", description: "CARD PAYMENT NEW", amount_cents: -1000 },
    { date: "2026-08-03", description: "CARD PAYMENT BAD", amount_cents: -999 },
  ],
});
const cardPayment = (await call("list_transactions", { account: acct.id, search: "CARD PAYMENT" }))[0];
const cheqPayments = await call("list_transactions", { account: cheq.id, search: "CARD PAYMENT" });
const oldSide = cheqPayments.find((r: { description_raw: string }) => r.description_raw.endsWith("OLD"));
const newSide = cheqPayments.find((r: { description_raw: string }) => r.description_raw.endsWith("NEW"));
const badSide = cheqPayments.find((r: { description_raw: string }) => r.description_raw.endsWith("BAD"));
await call("link_transfer_pair", { transaction_id_a: cardPayment.id, transaction_id_b: oldSide.id });
await call("link_transfer_pair", { transaction_id_a: cardPayment.id, transaction_id_b: newSide.id });
const oldAfterRepair = (await call("list_transactions", { account: cheq.id, search: "OLD" }))[0];
assert.equal(oldAfterRepair.is_transfer, 0, "old peer must be unmarked when its partner is re-paired");

let mismatchRejected = false;
try {
  await call("link_transfer_pair", { transaction_id_a: cardPayment.id, transaction_id_b: badSide.id });
} catch (err) {
  mismatchRejected = String(err).includes("exact opposite amounts");
}
assert.equal(mismatchRejected, true, "mismatched transfer should require an explicit override");

// A partial reimbursement is paired one-to-one, reduces the original month's
// category spend, and remains visible as a real account transaction.
await call("import_transactions", {
  account: cheq.id,
  transactions: [
    { date: "2026-07-31", description: "MONTHLY RENT", amount_cents: -200000, category: "Rent" },
    { date: "2026-08-02", description: "ROOMMATE RENT SHARE", amount_cents: 100000 },
  ],
});
const rentExpense = (await call("list_transactions", { account: cheq.id, search: "MONTHLY RENT" }))[0];
const rentRefund = (await call("list_transactions", { account: cheq.id, search: "ROOMMATE RENT SHARE" }))[0];
await call("link_refund_pair", {
  expense_transaction_id: rentExpense.id,
  refund_transaction_id: rentRefund.id,
});
const linkedRent = (await call("list_transactions", { account: cheq.id, search: "MONTHLY RENT" }))[0];
const linkedRefund = (await call("list_transactions", { account: cheq.id, search: "ROOMMATE RENT SHARE" }))[0];
assert.equal(linkedRent.refund_peer_id, linkedRefund.id);
assert.equal(linkedRefund.refund_peer_id, linkedRent.id);
const julyAfterRefund = await call("get_summary", { month: "2026-07" });
assert.equal(
  julyAfterRefund.spending_by_category.find((row: { category: string }) => row.category === "Rent")
    ?.spent_cad_cents,
  100000
);
await call("unlink_refund_pair", { transaction_id: rentRefund.id });
const julyAfterUnlink = await call("get_summary", { month: "2026-07" });
assert.equal(
  julyAfterUnlink.spending_by_category.find((row: { category: string }) => row.category === "Rent")
    ?.spent_cad_cents,
  200000
);
await call("link_refund_pair", {
  expense_transaction_id: rentExpense.id,
  refund_transaction_id: rentRefund.id,
});

// Uploaded statement PDFs are discoverable/readable as MCP resources and only
// become processed after a successful linked import.
const pdfAccount = await call("create_account", { name: "PDF Inbox", type: "savings" });
fs.mkdirSync(SCRATCH_STATEMENTS, { recursive: true });
const addDocument = (
  name: string,
  body: string,
  accountId: number | null = pdfAccount.id,
  mimeType: "application/pdf" | "text/csv" = "application/pdf"
) => {
  const bytes = Buffer.from(
    mimeType === "application/pdf" ? `%PDF-1.7\n${body}\n%%EOF` : body
  );
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const extension = mimeType === "application/pdf" ? "pdf" : "csv";
  fs.writeFileSync(path.join(SCRATCH_STATEMENTS, `${sha256}.${extension}`), bytes);
  const sideDb = new DatabaseSync(SCRATCH_DB);
  const result = sideDb.prepare(
    `INSERT INTO statement_documents
     (account_id, original_name, storage_key, file_sha256, size_bytes, mime_type)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(accountId, name, sha256, sha256, bytes.byteLength, mimeType);
  sideDb.close();
  return { id: Number(result.lastInsertRowid), bytes };
};
const documentA = addDocument("pdf-inbox-a.pdf", "resource A");
const documentB = addDocument("pdf-inbox-b.pdf", "resource B");
const documentC = addDocument(
  "unassigned.csv",
  "Date,Description,Amount\n2026-09-04,AI CHOOSES ACCOUNT,7.00\n",
  null,
  "text/csv"
);

const pendingDocuments = await call("list_statement_documents", {});
assert.deepEqual(
  pendingDocuments.map((document: { id: number }) => document.id).sort((a: number, b: number) => a - b),
  [documentA.id, documentB.id, documentC.id]
);
const resources = await client.listResources();
assert.ok(resources.resources.some((resource) => resource.uri === `statement://documents/${documentA.id}`));
const resource = await client.readResource({ uri: `statement://documents/${documentA.id}` });
const blob = (resource.contents[0] as { blob: string }).blob;
assert.deepEqual(Buffer.from(blob, "base64"), documentA.bytes);
const csvResource = await client.readResource({
  uri: `statement://documents/${documentC.id}`,
});
assert.equal(
  (csvResource.contents[0] as { text: string }).text,
  documentC.bytes.toString("utf8")
);

const autoAssigned = await call("import_transactions", {
  account: pdfAccount.id,
  statement_document_id: documentC.id,
  transactions: [
    {
      date: "2026-09-04",
      description: "AI CHOOSES ACCOUNT",
      amount_cents: 700,
    },
  ],
});
assert.equal(autoAssigned.statement_document_id, documentC.id);
const allDocuments = await call("list_statement_documents", { status: "all" });
assert.equal(
  allDocuments.find((document: { id: number }) => document.id === documentC.id)?.account_id,
  pdfAccount.id,
  "successful import should assign an unassigned Inbox file to the AI-selected account"
);

const linkedImport = await call("import_transactions", {
  account: pdfAccount.id,
  statement_document_id: documentA.id,
  statement_start_date: "2026-08-15",
  statement_end_date: "2026-09-14",
  transactions: [{ date: "2026-09-01", description: "PDF LINK", amount_cents: 123 }],
});
assert.equal(linkedImport.statement_document_id, documentA.id);
const linkedHistory = await call("list_imports", {});
const linkedHistoryRow = linkedHistory.find(
  (entry: { id: number }) => entry.id === linkedImport.import_id
);
assert.equal(linkedHistoryRow.statement_start_date, "2026-08-15");
assert.equal(linkedHistoryRow.statement_end_date, "2026-09-14");
let alreadyLinkedRejected = false;
try {
  await call("import_transactions", {
    account: pdfAccount.id,
    statement_document_id: documentA.id,
    transactions: [{ date: "2026-09-02", description: "SHOULD FAIL", amount_cents: 1 }],
  });
} catch (error) {
  alreadyLinkedRejected = String(error).includes("already linked");
}
assert.equal(alreadyLinkedRejected, true);

await call("undo_import", { import_id: linkedImport.import_id });
const afterUndo = await call("list_statement_documents", {});
assert.equal(
  afterUndo.find((document: { id: number }) => document.id === documentA.id)?.processing_status,
  "undone"
);
const relinked = await call("import_transactions", {
  account: pdfAccount.id,
  statement_document_id: documentA.id,
  transactions: [{ date: "2026-09-01", description: "PDF LINK", amount_cents: 123 }],
});
assert.equal(relinked.statement_document_id, documentA.id);

let wrongAccountRejected = false;
try {
  await call("import_transactions", {
    account: acct.id,
    statement_document_id: documentB.id,
    transactions: [{ date: "2026-09-03", description: "WRONG ACCOUNT", amount_cents: 5 }],
  });
} catch (error) {
  wrongAccountRejected = String(error).includes("belongs to");
}
assert.equal(wrongAccountRejected, true, "a stored PDF can only be linked to its selected account");

const rejectedDocumentImport = await call("import_transactions", {
  account: pdfAccount.id,
  statement_document_id: documentB.id,
  statement_end_balance_cents: 999999,
  transactions: [{ date: "2026-09-03", description: "PDF MISMATCH", amount_cents: 5 }],
});
assert.equal(rejectedDocumentImport.rejected, true);
const afterRejected = await call("list_statement_documents", {});
assert.ok(afterRejected.some((document: { id: number }) => document.id === documentB.id));

// update_account: the opening balance is "as of" the END of opening_balance_date,
// so a transaction posted ON that date is excluded. Moving the date one day
// earlier is the fix, and it must show up as a balance delta.
const sav = await call("create_account", {
  name: "Scotia Savings",
  type: "savings",
  opening_balance_cents: 0,
  opening_balance_date: "2025-09-22",
});
await call("import_transactions", {
  account: sav.id,
  transactions: [
    { date: "2025-09-22", description: "customer transfer cr.", amount_cents: 10000 },
    { date: "2025-09-23", description: "interest", amount_cents: 5000 },
  ],
});
const strandedOnOpeningDate = (await call("list_accounts", {})).find((a: { id: number }) => a.id === sav.id);
assert.equal(strandedOnOpeningDate.balance_cents, 5000, "txn on the opening date must be excluded");
assert.equal(strandedOnOpeningDate.txn_count, 1);

const fixed = await call("update_account", { account: sav.id, opening_balance_date: "2025-09-21" });
assert.equal(fixed.balance_before_cents, 5000);
assert.equal(fixed.balance_after_cents, 15000, "moving the date back one day must pull in the 09-22 txn");
assert.equal(fixed.balance_delta_cents, 10000);
assert.equal(fixed.txn_count_before, 1);
assert.equal(fixed.txn_count_after, 2);
assert.deepEqual(fixed.changed_fields, ["opening_balance_date"]);

// renaming works, and null clears a nullable field
const renamed = await call("update_account", {
  account: sav.id,
  name: "Scotia Momentum PLUS",
  institution: "Scotiabank",
  last4: "1234",
});
assert.equal(renamed.account.name, "Scotia Momentum PLUS");
assert.equal(renamed.account.institution, "Scotiabank");
assert.equal(renamed.balance_delta_cents, 0, "renaming must not move the balance");
const cleared = await call("update_account", { account: "Scotia Momentum PLUS", last4: null });
assert.equal(cleared.account.last4, null, "null must clear last4");

// guards: duplicate names would make name-based lookups ambiguous, and an
// empty update is a caller mistake worth surfacing.
let dupRejected = false;
try {
  await call("update_account", { account: sav.id, name: "Chequing" });
} catch (err) {
  dupRejected = String(err).includes("already named");
}
assert.equal(dupRejected, true, "renaming onto another account's name should be rejected");

let emptyRejected = false;
try {
  await call("update_account", { account: sav.id });
} catch (err) {
  emptyRejected = String(err).includes("nothing to update");
}
assert.equal(emptyRejected, true, "an update with no fields should be rejected");

// flipping to credit flips kind, and warns because history already exists
const flipped = await call("update_account", { account: sav.id, type: "credit" });
assert.equal(flipped.account.kind, "liability");
assert.ok(
  flipped.warnings?.some((w: string) => w.includes("flips it between asset and liability")),
  "changing type on an account with transactions should warn"
);

console.log(
  "MCP e2e OK — precedence, reconciliation, statement resources, dedupe, FX, transfer/refund integrity, account updates"
);
await client.close();
fs.rmSync(scratchDir, { recursive: true, force: true });
