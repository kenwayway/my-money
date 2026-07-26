/**
 * my-money MCP server (stdio).
 *
 * Exposes the finance database to an AI client (Claude Code / Claude Desktop).
 * The AI does the intelligent work — parsing bank statements in whatever format,
 * choosing categories — and calls these tools to write the results. The server
 * guarantees the invariants: dedupe fingerprints, import batches with undo,
 * merchant-rule learning, balance math.
 *
 * Shares data/money.db with the web app (WAL mode — both can run at once).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import crypto from "node:crypto";
import { db, tx, initDb } from "./db/connection.js";
import { seedDb } from "./db/seed.js";
import { normalizeMerchant, upsertRuleSafe, categorizeByRules } from "./services/categorizer.js";
import { dedupeRows } from "./import/dedupe.js";
import { netWorth, withBalance, balanceAsOf } from "./services/balances.js";
import { suggestTransferPairs, pairTransfer } from "./services/transfers.js";
import { currentLocalMonth, monthlySpendingByCategory } from "./services/spending.js";
import type { Account, Category } from "@my-money/shared";

initDb();
seedDb();

// ---------- helpers ----------

function categoriesByName(): Map<string, Category> {
  const cats = db.prepare("SELECT * FROM categories").all() as unknown as Category[];
  return new Map(cats.map((c) => [c.name.toLowerCase(), c]));
}

function accountByRef(ref: string | number): Account | undefined {
  if (typeof ref === "number" || /^\d+$/.test(String(ref))) {
    return db.prepare("SELECT * FROM accounts WHERE id = ?").get(Number(ref)) as unknown as Account | undefined;
  }
  return db.prepare("SELECT * FROM accounts WHERE lower(name) = lower(?) AND archived = 0").get(String(ref)) as
    | Account
    | undefined as Account | undefined;
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

// ---------- tool definitions ----------

const TOOLS = [
  {
    name: "list_accounts",
    description:
      "List all accounts (cards) with computed balances in their native currency and converted to CAD. Use this first to find the right account_id for imports.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_account",
    description:
      "Create an account (a card). type 'credit' automatically becomes a liability. opening_balance_cents: the balance (signed integer cents) as of opening_balance_date; transactions dated after that date are added on top. For credit cards, money owed is negative. For investment/retirement accounts (Wealthsimple, IBKR, RRSP/TFSA) use type 'investment' and track the value with set_balance_snapshot instead of importing transactions.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        type: { type: "string", enum: ["chequing", "savings", "credit", "prepaid", "cash", "investment"] },
        institution: { type: "string" },
        currency: { type: "string", description: "ISO 4217, default CAD" },
        last4: { type: "string" },
        opening_balance_cents: { type: "integer" },
        opening_balance_date: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["name", "type"],
      additionalProperties: false,
    },
  },
  {
    name: "list_categories",
    description: "List all spending/income categories. Use these exact names when categorizing transactions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "import_transactions",
    description:
      "Bulk-import transactions you parsed from a bank statement into one account. Amounts are SIGNED INTEGER CENTS in the account's native currency: inflows positive, outflows/spending NEGATIVE (a credit-card charge is negative; a credit-card payment received is positive). Dedupe is automatic — re-importing overlapping statements is safe; duplicates are skipped and reported. Provide a category name per transaction when you can infer one (use list_categories names; use 'Transfer' for e-transfers between the user's own accounts and credit-card payments). Categories you provide are remembered as merchant rules for future imports. If the statement shows a closing balance, ALSO pass statement_end_balance_cents — the import is then reconciled against it and sign mistakes are caught immediately. Returns an import_id that can undo the whole batch.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: ["string", "integer"], description: "Account id or exact account name" },
        source_label: { type: "string", description: "e.g. the statement file name, for the import history" },
        statement_end_balance_cents: {
          type: "integer",
          description:
            "Optional but RECOMMENDED when the statement shows a closing/new balance: signed cents in the account's native currency, in the app's convention — positive = money available (chequing/savings), NEGATIVE = money owed on a credit card (statement 'new balance $523.10' owed → -52310). After importing, the computed balance as of the statement end date is compared against this; a mismatch deterministically catches sign-convention or parsing mistakes.",
        },
        statement_end_date: {
          type: "string",
          description:
            "YYYY-MM-DD the closing balance refers to (the statement period end). Defaults to the latest transaction date in this import.",
        },
        transactions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              date: { type: "string", description: "YYYY-MM-DD posted date" },
              description: { type: "string", description: "Merchant/description as it appears on the statement" },
              amount_cents: { type: "integer", description: "Signed cents: +inflow, -outflow" },
              category: { type: "string", description: "Optional category name from list_categories" },
            },
            required: ["date", "description", "amount_cents"],
            additionalProperties: false,
          },
        },
      },
      required: ["account", "transactions"],
      additionalProperties: false,
    },
  },
  {
    name: "list_transactions",
    description: "Query transactions with filters. Returns newest first.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: ["string", "integer"], description: "Account id or name" },
        month: { type: "string", description: "YYYY-MM" },
        category: { type: "string", description: "Category name" },
        uncategorized_only: { type: "boolean" },
        search: { type: "string", description: "Substring match on description or notes" },
        limit: { type: "integer", description: "Default 50, max 500" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "set_category",
    description:
      "Set the category of one transaction (by id). Creates a merchant rule so the same merchant is auto-categorized in the future. apply_to_same_merchant also re-categorizes all other transactions of that merchant.",
    inputSchema: {
      type: "object",
      properties: {
        transaction_id: { type: "integer" },
        category: { type: ["string", "null"], description: "Category name, or null to clear" },
        apply_to_same_merchant: { type: "boolean" },
      },
      required: ["transaction_id", "category"],
      additionalProperties: false,
    },
  },
  {
    name: "set_note",
    description:
      "Attach a free-text note to a transaction (or null to clear it). Useful when the statement description is cryptic — e.g. what an e-transfer or a generic 'POS PURCHASE' actually was.",
    inputSchema: {
      type: "object",
      properties: {
        transaction_id: { type: "integer" },
        note: { type: ["string", "null"] },
      },
      required: ["transaction_id", "note"],
      additionalProperties: false,
    },
  },
  {
    name: "mark_transfer",
    description:
      "Mark/unmark a transaction as a transfer between the user's own accounts (excluded from spending stats). Typical: credit-card payments, e-transfers to self.",
    inputSchema: {
      type: "object",
      properties: {
        transaction_id: { type: "integer" },
        is_transfer: { type: "boolean" },
      },
      required: ["transaction_id", "is_transfer"],
      additionalProperties: false,
    },
  },
  {
    name: "link_transfer_pair",
    description:
      "Link two transactions (usually in different accounts) as the two sides of one internal transfer — e.g. a credit-card payment and the matching chequing withdrawal. Both are marked as transfers (excluded from spending stats) and linked to each other. Use the transfer_pair_suggestions from get_summary to find candidates.",
    inputSchema: {
      type: "object",
      properties: {
        transaction_id_a: { type: "integer" },
        transaction_id_b: { type: "integer" },
      },
      required: ["transaction_id_a", "transaction_id_b"],
      additionalProperties: false,
    },
  },
  {
    name: "get_summary",
    description:
      "Net worth across all accounts (in CAD) plus spending by category for a month (also converted to CAD). Also lists transfer-pair suggestions (opposite amounts across accounts that look like internal transfers).",
    inputSchema: {
      type: "object",
      properties: { month: { type: "string", description: "YYYY-MM, default current month" } },
      additionalProperties: false,
    },
  },
  {
    name: "list_imports",
    description: "Import history (batches). Each committed import can be undone.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "undo_import",
    description: "Undo an import batch: deletes every transaction it inserted.",
    inputSchema: {
      type: "object",
      properties: { import_id: { type: "integer" } },
      required: ["import_id"],
      additionalProperties: false,
    },
  },
  {
    name: "set_fx_rate",
    description: "Set the exchange rate used to convert a currency to CAD in net-worth summaries (e.g. USD 1.37).",
    inputSchema: {
      type: "object",
      properties: {
        currency: { type: "string", description: "ISO 4217, e.g. USD" },
        rate_to_cad: { type: "number" },
      },
      required: ["currency", "rate_to_cad"],
      additionalProperties: false,
    },
  },
  {
    name: "set_balance_snapshot",
    description:
      "Record an account's balance as of a date. This is THE way to track investment/retirement accounts (Wealthsimple, IBKR, RRSP/TFSA): their market value moves without transactions, so instead of importing a ledger, periodically snapshot the current value — e.g. when the user says 'my Wealthsimple TFSA is at $23,450 now'. The account's balance is anchored on its latest snapshot (+ any transactions after that date), and net worth uses it. Also useful as a reconciliation anchor for cash accounts. Signed integer cents in the account's native currency. Snapshotting the same account+date again overwrites that snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: ["string", "integer"], description: "Account id or exact account name" },
        balance_cents: { type: "integer", description: "Signed cents; for a liability, money owed is negative" },
        date: { type: "string", description: "YYYY-MM-DD the balance refers to; defaults to today" },
        note: { type: "string", description: "Optional note, e.g. 'after July contribution'" },
      },
      required: ["account", "balance_cents"],
      additionalProperties: false,
    },
  },
  {
    name: "list_balance_snapshots",
    description: "Snapshot history for one account (newest first) — shows how its value moved over time.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: ["string", "integer"], description: "Account id or exact account name" },
        limit: { type: "integer", description: "Default 24" },
      },
      required: ["account"],
      additionalProperties: false,
    },
  },
];

// ---------- tool handlers ----------

type Args = Record<string, unknown>;

const handlers: Record<string, (args: Args) => unknown> = {
  list_accounts() {
    const accounts = (db.prepare("SELECT * FROM accounts WHERE archived = 0 ORDER BY created_at").all() as unknown as Account[]).map(
      withBalance
    );
    return accounts.map((a) => ({
      id: a.id,
      name: a.name,
      institution: a.institution,
      type: a.type,
      kind: a.kind,
      currency: a.currency,
      last4: a.last4,
      balance_cents: a.balance_cents,
      balance_cad_cents: a.balance_cad_cents,
      txn_count: a.txn_count,
      balance_source: a.balance_source,
      ...(a.balance_as_of ? { balance_as_of: a.balance_as_of } : {}),
    }));
  },

  create_account(args) {
    const type = String(args.type);
    const info = db
      .prepare(
        `INSERT INTO accounts (name, institution, type, kind, currency, last4, opening_balance_cents, opening_balance_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        String(args.name),
        args.institution != null ? String(args.institution) : null,
        type,
        type === "credit" ? "liability" : "asset",
        String(args.currency ?? "CAD").toUpperCase(),
        args.last4 != null ? String(args.last4) : null,
        Number(args.opening_balance_cents ?? 0),
        args.opening_balance_date != null ? String(args.opening_balance_date) : null
      );
    const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(info.lastInsertRowid) as unknown as Account;
    return withBalance(account);
  },

  list_categories() {
    return db.prepare("SELECT id, name, type FROM categories ORDER BY sort_order, name").all();
  },

  import_transactions(args) {
    const account = accountByRef(args.account as string | number);
    if (!account) throw new Error(`account not found: ${args.account}. Call list_accounts first.`);
    const txns = args.transactions as { date: string; description: string; amount_cents: number; category?: string }[];
    if (!Array.isArray(txns) || txns.length === 0) throw new Error("transactions array is empty");

    const cats = categoriesByName();
    const unknownCategories = new Set<string>();

    // validate rows
    const rows = txns.map((t, i) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date)) throw new Error(`row ${i}: date must be YYYY-MM-DD, got "${t.date}"`);
      if (!Number.isInteger(t.amount_cents)) throw new Error(`row ${i}: amount_cents must be an integer (signed cents)`);
      return {
        row_index: i,
        posted_date: t.date,
        description_raw: t.description,
        merchant_norm: normalizeMerchant(t.description) || "(NO DESCRIPTION)",
        amount_cents: t.amount_cents,
        balance_cents: null,
      };
    });

    const deduped = dedupeRows(account.id, rows);
    const toInsert = deduped.filter((r) => !r.duplicate);

    // categories: explicit from AI > learned rules
    const ruleResults = categorizeByRules(toInsert.map((r) => r.merchant_norm));
    const payloadSha = crypto.createHash("sha256").update(JSON.stringify(txns)).digest("hex");

    const result = tx(() => {
      const importInfo = db
        .prepare(
          `INSERT INTO imports (account_id, file_name, file_sha256, spec_id, row_count, inserted_count, skipped_dupes, status)
           VALUES (?, ?, ?, NULL, ?, ?, ?, 'committed')`
        )
        .run(
          account.id,
          String(args.source_label ?? "mcp-import"),
          payloadSha,
          deduped.length,
          toInsert.length,
          deduped.length - toInsert.length
        );
      const importId = Number(importInfo.lastInsertRowid);

      const insert = db.prepare(
        `INSERT OR IGNORE INTO transactions
         (account_id, posted_date, description_raw, merchant_norm, amount_cents, category_id, category_source, is_transfer, import_id, fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      let inserted = 0;
      for (const r of deduped) {
        if (r.duplicate) continue;
        const provided = txns[r.row_index]?.category;
        let categoryId: number | null = null;
        let source: string | null = null;
        if (provided) {
          const cat = cats.get(provided.toLowerCase());
          if (cat) {
            categoryId = cat.id;
            source = "ai";
            upsertRuleSafe(r.merchant_norm, cat.id, "ai"); // remember for future imports
          } else {
            unknownCategories.add(provided);
          }
        }
        if (categoryId === null) {
          const rule = ruleResults.get(r.merchant_norm);
          if (rule?.category_id != null) {
            categoryId = rule.category_id;
            source = "rule";
          }
        }
        const isTransfer = categoryId !== null && cats.get("transfer")?.id === categoryId ? 1 : 0;
        const info = insert.run(
          account.id,
          r.posted_date,
          r.description_raw,
          r.merchant_norm,
          r.amount_cents,
          categoryId,
          source,
          isTransfer,
          importId,
          r.fingerprint
        );
        inserted += Number(info.changes);
      }
      db.prepare("UPDATE imports SET inserted_count = ? WHERE id = ?").run(inserted, importId);
      return { import_id: importId, inserted, skipped_duplicates: deduped.length - inserted };
    });

    // optional reconciliation against the statement's closing balance — the
    // deterministic net for sign-convention or parsing mistakes by the AI client
    let balanceCheck: Record<string, unknown> | undefined;
    if (args.statement_end_balance_cents != null) {
      const expected = Number(args.statement_end_balance_cents);
      if (!Number.isInteger(expected)) throw new Error("statement_end_balance_cents must be an integer (signed cents)");
      let endDate: string;
      if (args.statement_end_date != null) {
        endDate = String(args.statement_end_date);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw new Error("statement_end_date must be YYYY-MM-DD");
      } else {
        endDate = rows.reduce((max, r) => (r.posted_date > max ? r.posted_date : max), rows[0]!.posted_date);
      }
      if (account.opening_balance_date && endDate <= account.opening_balance_date) {
        balanceCheck = {
          status: "n/a",
          message: `statement ends on/before the account's opening-balance date (${account.opening_balance_date}) — nothing to reconcile against`,
        };
      } else {
        const computed = balanceAsOf(account, endDate);
        const fmt = (cents: number) => `${(cents / 100).toFixed(2)} ${account.currency}`;
        balanceCheck =
          computed === expected
            ? { status: "ok", as_of: endDate, balance_cents: computed }
            : {
                status: "mismatch",
                as_of: endDate,
                computed_cents: computed,
                statement_cents: expected,
                diff_cents: computed - expected,
                message:
                  `computed balance ${fmt(computed)} as of ${endDate} does not match the statement's closing balance ${fmt(expected)} (off by ${fmt(computed - expected)}). ` +
                  `Likely causes: wrong amount signs in this import (undo with undo_import(${result.import_id})), ` +
                  `earlier transactions not yet imported, or an unset/incorrect opening balance on the account.`,
              };
      }
    }

    const balance = withBalance(db.prepare("SELECT * FROM accounts WHERE id = ?").get(account.id) as unknown as Account);
    return {
      ...result,
      account: account.name,
      new_balance_cents: balance.balance_cents,
      currency: account.currency,
      ...(balanceCheck ? { balance_check: balanceCheck } : {}),
      ...(unknownCategories.size > 0
        ? { warning: `unknown categories ignored: ${[...unknownCategories].join(", ")} — use list_categories names` }
        : {}),
      hint: result.inserted > 0 ? `Undo with undo_import(${result.import_id}) if something looks wrong.` : undefined,
    };
  },

  list_transactions(args) {
    const cond: string[] = [];
    const params: Record<string, string | number> = {};
    if (args.account != null) {
      const account = accountByRef(args.account as string | number);
      if (!account) throw new Error(`account not found: ${args.account}`);
      cond.push("t.account_id = @account_id");
      params.account_id = account.id;
    }
    if (args.month) {
      cond.push("substr(t.posted_date, 1, 7) = @month");
      params.month = String(args.month);
    }
    if (args.category) {
      cond.push("lower(c.name) = lower(@category)");
      params.category = String(args.category);
    }
    if (args.uncategorized_only) cond.push("t.category_id IS NULL");
    if (args.search) {
      cond.push("(t.description_raw LIKE @search OR t.merchant_norm LIKE @search OR t.notes LIKE @search)");
      params.search = `%${args.search}%`;
    }
    const limit = Math.min(Number(args.limit ?? 50), 500);
    const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
    const stmt = db.prepare(
      `SELECT t.id, t.posted_date, t.description_raw, t.amount_cents, t.is_transfer, t.notes,
              a.name AS account, a.currency, c.name AS category
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN categories c ON c.id = t.category_id
       ${where}
       ORDER BY t.posted_date DESC, t.id DESC
       LIMIT ${limit}`
    );
    return cond.length ? stmt.all(params) : stmt.all();
  },

  set_category(args) {
    const id = Number(args.transaction_id);
    const txn = db.prepare("SELECT * FROM transactions WHERE id = ?").get(id) as
      | { merchant_norm: string }
      | undefined;
    if (!txn) throw new Error(`transaction ${id} not found`);
    let categoryId: number | null = null;
    if (args.category !== null) {
      const cat = categoriesByName().get(String(args.category).toLowerCase());
      if (!cat) throw new Error(`unknown category "${args.category}" — use list_categories names`);
      categoryId = cat.id;
    }
    let bulkUpdated = 0;
    tx(() => {
      db.prepare("UPDATE transactions SET category_id = ?, category_source = ? WHERE id = ?").run(
        categoryId,
        categoryId === null ? null : "user",
        id
      );
      if (categoryId !== null) {
        upsertRuleSafe(txn.merchant_norm, categoryId, "user");
        if (args.apply_to_same_merchant) {
          const info = db
            .prepare(
              `UPDATE transactions SET category_id = ?, category_source = 'user'
               WHERE merchant_norm = ? AND id != ? AND (category_source IS NULL OR category_source != 'user')`
            )
            .run(categoryId, txn.merchant_norm, id);
          bulkUpdated = Number(info.changes);
        }
      }
    });
    return { updated: true, also_updated_same_merchant: bulkUpdated };
  },

  set_note(args) {
    const id = Number(args.transaction_id);
    const exists = db.prepare("SELECT id FROM transactions WHERE id = ?").get(id);
    if (!exists) throw new Error(`transaction ${id} not found`);
    const note = args.note == null ? null : String(args.note).trim() || null;
    db.prepare("UPDATE transactions SET notes = ? WHERE id = ?").run(note, id);
    return { updated: true, note };
  },

  mark_transfer(args) {
    const id = Number(args.transaction_id);
    const exists = db.prepare("SELECT id FROM transactions WHERE id = ?").get(id);
    if (!exists) throw new Error(`transaction ${id} not found`);
    if (args.is_transfer) {
      db.prepare("UPDATE transactions SET is_transfer = 1 WHERE id = ?").run(id);
    } else {
      // unmarking also dissolves any pairing
      db.prepare("UPDATE transactions SET is_transfer = 0, transfer_peer_id = NULL WHERE id = ?").run(id);
    }
    return { updated: true };
  },

  link_transfer_pair(args) {
    const { a, b } = pairTransfer(Number(args.transaction_id_a), Number(args.transaction_id_b));
    const warning =
      a.amount_cents + b.amount_cents !== 0
        ? "amounts are not exact opposites — double-check these are really two sides of one transfer"
        : undefined;
    return { paired: true, a, b, ...(warning ? { warning } : {}) };
  },

  get_summary(args) {
    const month = String(args.month ?? currentLocalMonth());
    const nw = netWorth();
    // CAD-converted per account — same math as the web dashboard
    const spendRows = monthlySpendingByCategory(month).map((s) => ({
      category: s.category_name,
      spent_cad_cents: s.total_cad_cents,
      txn_count: s.txn_count,
    }));
    const uncategorized = (
      db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE category_id IS NULL AND is_transfer = 0").get() as {
        n: number;
      }
    ).n;
    return {
      month,
      net_worth_cad_cents: nw.total_cad_cents,
      assets_cad_cents: nw.assets_cad_cents,
      liabilities_cad_cents: nw.liabilities_cad_cents,
      accounts: nw.accounts.map((a) => ({ name: a.name, currency: a.currency, balance_cents: a.balance_cents, balance_cad_cents: a.balance_cad_cents })),
      spending_by_category: spendRows,
      uncategorized_count: uncategorized,
      transfer_pair_suggestions: suggestTransferPairs().slice(0, 10),
    };
  },

  list_imports() {
    return db
      .prepare(
        `SELECT i.id, i.file_name, a.name AS account, i.inserted_count, i.skipped_dupes, i.status,
                datetime(i.created_at, 'unixepoch') AS created_at
         FROM imports i JOIN accounts a ON a.id = i.account_id ORDER BY i.created_at DESC LIMIT 50`
      )
      .all();
  },

  undo_import(args) {
    const id = Number(args.import_id);
    const imp = db.prepare("SELECT status FROM imports WHERE id = ?").get(id) as { status: string } | undefined;
    if (!imp) throw new Error(`import ${id} not found`);
    if (imp.status === "undone") throw new Error(`import ${id} was already undone`);
    const deleted = tx(() => {
      const del = db.prepare("DELETE FROM transactions WHERE import_id = ?").run(id);
      db.prepare("UPDATE imports SET status = 'undone' WHERE id = ?").run(id);
      return Number(del.changes);
    });
    return { undone: true, deleted_transactions: deleted };
  },

  set_fx_rate(args) {
    const currency = String(args.currency).toUpperCase();
    const rate = Number(args.rate_to_cad);
    if (!(rate > 0)) throw new Error("rate_to_cad must be positive");
    db.prepare(
      `INSERT INTO fx_rates (currency, rate_to_cad, updated_at) VALUES (?, ?, unixepoch())
       ON CONFLICT(currency) DO UPDATE SET rate_to_cad = excluded.rate_to_cad, updated_at = unixepoch()`
    ).run(currency, rate);
    return { currency, rate_to_cad: rate };
  },

  set_balance_snapshot(args) {
    const account = accountByRef(args.account as string | number);
    if (!account) throw new Error(`account not found: ${args.account}. Call list_accounts first.`);
    const balance = Number(args.balance_cents);
    if (!Number.isInteger(balance)) throw new Error("balance_cents must be an integer (signed cents)");
    const date = args.date != null ? String(args.date) : new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must be YYYY-MM-DD");
    if (account.kind === "liability" && balance > 0) {
      // not an error — but worth flagging, since owed money should be negative
      console.error(`[snapshot] warning: positive snapshot on liability account ${account.name}`);
    }
    db.prepare(
      `INSERT INTO balance_snapshots (account_id, snapshot_date, balance_cents, note) VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id, snapshot_date) DO UPDATE SET balance_cents = excluded.balance_cents, note = excluded.note`
    ).run(account.id, date, balance, args.note != null ? String(args.note) : null);
    const updated = withBalance(db.prepare("SELECT * FROM accounts WHERE id = ?").get(account.id) as unknown as Account);
    const prev = db
      .prepare(
        "SELECT snapshot_date, balance_cents FROM balance_snapshots WHERE account_id = ? AND snapshot_date < ? ORDER BY snapshot_date DESC LIMIT 1"
      )
      .get(account.id, date) as { snapshot_date: string; balance_cents: number } | undefined;
    return {
      account: account.name,
      snapshot_date: date,
      balance_cents: balance,
      currency: account.currency,
      current_balance_cents: updated.balance_cents,
      ...(prev
        ? { change_since_previous: { from_date: prev.snapshot_date, delta_cents: balance - prev.balance_cents } }
        : {}),
      ...(account.kind === "liability" && balance > 0
        ? { warning: "this is a liability account — money owed should normally be a NEGATIVE balance" }
        : {}),
    };
  },

  list_balance_snapshots(args) {
    const account = accountByRef(args.account as string | number);
    if (!account) throw new Error(`account not found: ${args.account}`);
    const limit = Math.min(Number(args.limit ?? 24), 200);
    return db
      .prepare(
        `SELECT snapshot_date, balance_cents, note FROM balance_snapshots
         WHERE account_id = ? ORDER BY snapshot_date DESC LIMIT ${limit}`
      )
      .all(account.id);
  },
};

// ---------- wire up ----------

const server = new Server({ name: "my-money", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, (req) => {
  const handler = handlers[req.params.name];
  if (!handler) return fail(`unknown tool: ${req.params.name}`);
  try {
    return ok(handler((req.params.arguments ?? {}) as Args));
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[my-money] MCP server ready (stdio)`);
