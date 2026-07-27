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

// reconciliation: -5000 -3000 -2000 -100 = -10100 matches → ok; wrong balance → mismatch
const imp4 = await call("import_transactions", {
  account: acct.id,
  transactions: [{ date: "2026-07-20", description: "COFFEE", amount_cents: -100 }],
  statement_end_balance_cents: -10100,
});
assert.equal(imp4.balance_check.status, "ok");
const imp5 = await call("import_transactions", {
  account: acct.id,
  transactions: [{ date: "2026-07-21", description: "TEA", amount_cents: -200 }],
  statement_end_balance_cents: -99999,
});
assert.equal(imp5.balance_check.status, "mismatch");

// dedupe: re-importing an overlapping batch inserts nothing
const imp6 = await call("import_transactions", {
  account: acct.id,
  transactions: [{ date: "2026-07-16", description: "UNIQLO RIDEAU", amount_cents: -2000 }],
});
assert.equal(imp6.inserted, 0);
assert.equal(imp6.skipped_duplicates, 1);

console.log("MCP e2e OK — precedence, reconciliation, dedupe");
await client.close();
fs.rmSync(scratchDir, { recursive: true, force: true });
