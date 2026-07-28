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
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "my-money-e2e-"));
const SCRATCH_DB = path.join(scratchDir, "e2e.db");

// tsx may be hoisted to the repo root — resolve it the way node would
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [tsxCli, path.join(here, "..", "src", "mcp.ts")],
  env: { ...(process.env as Record<string, string>), MY_MONEY_DB: SCRATCH_DB },
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

console.log("MCP e2e OK — precedence, reconciliation rollback, dedupe, FX, transfer integrity");
await client.close();
fs.rmSync(scratchDir, { recursive: true, force: true });
