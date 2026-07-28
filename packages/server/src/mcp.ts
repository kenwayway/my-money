/**
 * my-money MCP server (stdio).
 *
 * Exposes the finance database to an AI client (Claude Code / Claude Desktop).
 * The AI does the intelligent work — parsing bank statements in whatever format,
 * choosing categories — and calls these tools to write the results. The server
 * guarantees the invariants: dedupe fingerprints, import batches with undo,
 * merchant-rule learning, balance math.
 *
 * Each tool's input is a zod schema — the single source of truth: it is
 * converted to the advertised JSON Schema AND enforced server-side on every
 * call (the MCP SDK does not validate arguments for us).
 *
 * Shares data/money.db with the web app (WAL mode — both can run at once).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import crypto from "node:crypto";
import { z } from "zod";
import { db, tx, initDb } from "./db/connection.js";
import { seedDb } from "./db/seed.js";
import { normalizeMerchant, upsertRuleSafe, categorizeByRules } from "./services/categorizer.js";
import { dedupeRows } from "./import/dedupe.js";
import { netWorth, withBalance, balanceAsOf } from "./services/balances.js";
import { suggestTransferPairs, pairTransfer, unmarkTransfer } from "./services/transfers.js";
import {
  currentLocalMonth,
  currentLocalDate,
  missingFxCurrenciesForRange,
  monthlySpendingByCategory,
} from "./services/spending.js";
import {
  defaultAccountColor,
  type Account,
  type Category,
} from "@my-money/shared";

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

// ---------- tool plumbing ----------

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const MonthStr = z.string().regex(/^\d{4}-\d{2}$/, "must be YYYY-MM");
const AccountRef = z.union([z.string(), z.number().int()]).describe("Account id or exact account name");

interface AnyTool {
  name: string;
  description: string;
  input: z.ZodType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any) => unknown;
}

/** Pairs a zod input schema with its handler, keeping the handler's args typed by that schema. */
function tool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  input: S;
  handler: (args: z.output<S>) => unknown;
}): AnyTool {
  return def;
}

// ---------- tools ----------

const TOOLS: AnyTool[] = [
  tool({
    name: "list_accounts",
    description:
      "List all accounts (cards) with computed balances in their native currency and converted to CAD. Use this first to find the right account_id for imports.",
    input: z.strictObject({}),
    handler() {
      const accounts = (
        db.prepare("SELECT * FROM accounts WHERE archived = 0 ORDER BY created_at").all() as unknown as Account[]
      ).map(withBalance);
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
  }),

  tool({
    name: "create_account",
    description:
      "Create an account (a card). type 'credit' automatically becomes a liability. opening_balance_cents: the balance (signed integer cents) as of opening_balance_date; transactions dated after that date are added on top. For credit cards, money owed is negative. For investment/retirement accounts (Wealthsimple, IBKR, RRSP/TFSA) use type 'investment' and track the value with set_balance_snapshot instead of importing transactions.",
    input: z.strictObject({
      name: z.string().min(1),
      type: z.enum(["chequing", "savings", "credit", "prepaid", "cash", "investment"]),
      institution: z.string().optional(),
      currency: z.string().length(3).optional().describe("ISO 4217, default CAD"),
      last4: z.string().max(4).optional(),
      opening_balance_cents: z.number().int().optional(),
      opening_balance_date: DateStr.optional().describe("YYYY-MM-DD"),
    }),
    handler(a) {
      const info = db
        .prepare(
          `INSERT INTO accounts
           (name, institution, type, kind, currency, last4, opening_balance_cents, opening_balance_date, color)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          a.name,
          a.institution ?? null,
          a.type,
          a.type === "credit" ? "liability" : "asset",
          (a.currency ?? "CAD").toUpperCase(),
          a.last4 ?? null,
          a.opening_balance_cents ?? 0,
          a.opening_balance_date ?? null,
          defaultAccountColor(a.type)
        );
      const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(info.lastInsertRowid) as unknown as Account;
      return withBalance(account);
    },
  }),

  tool({
    name: "list_categories",
    description: "List all spending/income categories. Use these exact names when categorizing transactions.",
    input: z.strictObject({}),
    handler() {
      return db.prepare("SELECT id, name, type FROM categories ORDER BY sort_order, name").all();
    },
  }),

  tool({
    name: "import_transactions",
    description:
      "Bulk-import transactions you parsed from a bank statement into one account. Amounts are SIGNED INTEGER CENTS in the account's native currency: inflows positive, outflows/spending NEGATIVE (a credit-card charge is negative; a credit-card payment received is positive). Dedupe is automatic — re-importing overlapping statements is safe; duplicates are skipped and reported. Provide a category name per transaction when you can infer one (use list_categories names; use 'Transfer' for e-transfers between the user's own accounts and credit-card payments). Categories you provide are remembered as merchant rules for future imports; where the user has previously corrected a merchant's category, that user rule takes precedence over your suggestion. If the statement shows a closing balance, ALSO pass statement_end_balance_cents — the import is reconciled before commit and rolls back by default if the balance does not match. Successful imports return an import_id that can undo the whole batch.",
    input: z.strictObject({
      account: AccountRef,
      source_label: z.string().optional().describe("e.g. the statement file name, for the import history"),
      statement_end_balance_cents: z
        .number()
        .int()
        .optional()
        .describe(
          "Optional but RECOMMENDED when the statement shows a closing/new balance: signed cents in the account's native currency, in the app's convention — positive = money available (chequing/savings), NEGATIVE = money owed on a credit card (statement 'new balance $523.10' owed → -52310). After importing, the computed balance as of the statement end date is compared against this; a mismatch deterministically catches sign-convention or parsing mistakes."
        ),
      statement_end_date: DateStr.optional().describe(
        "YYYY-MM-DD the closing balance refers to (the statement period end). Defaults to the latest transaction date in this import."
      ),
      allow_balance_mismatch: z
        .boolean()
        .default(false)
        .describe(
          "Explicitly commit even if reconciliation fails. Leave false unless the mismatch is understood (for example, older transactions have not been imported yet)."
        ),
      transactions: z
        .array(
          z.strictObject({
            date: DateStr.describe("YYYY-MM-DD posted date"),
            description: z.string().describe("Merchant/description as it appears on the statement"),
            amount_cents: z.number().int().describe("Signed cents: +inflow, -outflow"),
            category: z.string().optional().describe("Optional category name from list_categories"),
          })
        )
        .min(1),
    }),
    handler(a) {
      const account = accountByRef(a.account);
      if (!account) throw new Error(`account not found: ${a.account}. Call list_accounts first.`);
      const txns = a.transactions;

      const cats = categoriesByName();
      const unknownCategories = new Set<string>();

      const rows = txns.map((t, i) => ({
        row_index: i,
        posted_date: t.date,
        description_raw: t.description,
        merchant_norm: normalizeMerchant(t.description) || "(NO DESCRIPTION)",
        amount_cents: t.amount_cents,
        balance_cents: null,
      }));

      const deduped = dedupeRows(account.id, rows);
      const toInsert = deduped.filter((r) => !r.duplicate);

      // categories: user rule > explicit from AI > learned AI rule
      const ruleResults = categorizeByRules(toInsert.map((r) => r.merchant_norm));
      const payloadSha = crypto.createHash("sha256").update(JSON.stringify(txns)).digest("hex");
      const statementStartDate = rows.reduce(
        (min, r) => (r.posted_date < min ? r.posted_date : min),
        rows[0]!.posted_date
      );
      const statementEndDate =
        a.statement_end_date ??
        rows.reduce((max, r) => (r.posted_date > max ? r.posted_date : max), rows[0]!.posted_date);

      let balanceCheck: Record<string, unknown> | undefined;
      const reconciliationRejected = Symbol("reconciliation-rejected");
      type ImportResult = { import_id: number; inserted: number; skipped_duplicates: number };
      let result: ImportResult;

      try {
        result = tx(() => {
          const importInfo = db
            .prepare(
              `INSERT INTO imports
               (account_id, file_name, file_sha256, spec_id, row_count, inserted_count, skipped_dupes, status,
                source, statement_start_date, statement_end_date, statement_balance_cents, validation_status)
               VALUES (?, ?, ?, NULL, ?, ?, ?, 'committed', 'mcp', ?, ?, ?, 'passed')`
            )
            .run(
              account.id,
              a.source_label ?? "mcp-import",
              payloadSha,
              deduped.length,
              toInsert.length,
              deduped.length - toInsert.length,
              statementStartDate,
              statementEndDate,
              a.statement_end_balance_cents ?? null
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
            const rule = ruleResults.get(r.merchant_norm);
            let categoryId: number | null = null;
            let source: string | null = null;
            // precedence: user-made rule > AI-provided category > AI-made rule.
            // A user's correction is law — the AI's per-import suggestion never overrides it.
            if (rule?.category_id != null && rule.rule_source === "user") {
              categoryId = rule.category_id;
              source = "rule";
            }
            if (provided) {
              const cat = cats.get(provided.toLowerCase());
              if (!cat) {
                unknownCategories.add(provided);
              } else if (categoryId === null) {
                categoryId = cat.id;
                source = "ai";
                upsertRuleSafe(r.merchant_norm, cat.id, "ai"); // remembered only if the batch commits
              }
            }
            if (categoryId === null && rule?.category_id != null) {
              categoryId = rule.category_id;
              source = "rule";
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

          // Reconcile while the insert transaction is still open. A mismatch
          // rolls back the transactions, import record, and learned AI rules.
          let computedBalance: number | null = null;
          let reconciliationStatus: "not_checked" | "matched" | "mismatch" = "not_checked";
          if (a.statement_end_balance_cents !== undefined) {
            const expected = a.statement_end_balance_cents;
            const endDate = statementEndDate;
            if (account.opening_balance_date && endDate <= account.opening_balance_date) {
              balanceCheck = {
                status: "n/a",
                message: `statement ends on/before the account's opening-balance date (${account.opening_balance_date}) — nothing to reconcile against`,
              };
            } else {
              const computed = balanceAsOf(account, endDate);
              computedBalance = computed;
              reconciliationStatus = computed === expected ? "matched" : "mismatch";
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
                        `computed balance ${fmt(computed)} as of ${endDate} does not match the statement's closing balance ${fmt(expected)} ` +
                        `(off by ${fmt(computed - expected)}). Likely causes: wrong amount signs, earlier transactions not yet imported, ` +
                        `or an unset/incorrect opening balance.`,
                    };
              if (computed !== expected && !a.allow_balance_mismatch) throw reconciliationRejected;
            }
          }
          db.prepare(
            `UPDATE imports
             SET computed_balance_cents = ?, reconciliation_status = ?
             WHERE id = ?`
          ).run(computedBalance, reconciliationStatus, importId);

          return { import_id: importId, inserted, skipped_duplicates: deduped.length - inserted };
        });
      } catch (err) {
        if (err !== reconciliationRejected) throw err;
        return {
          rejected: true,
          inserted: 0,
          skipped_duplicates: deduped.length - toInsert.length,
          account: account.name,
          currency: account.currency,
          balance_check: balanceCheck,
          message:
            "Nothing was imported because reconciliation failed. Correct the transaction signs/opening balance, or retry with allow_balance_mismatch=true only if the difference is understood.",
        };
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
  }),

  tool({
    name: "list_transactions",
    description: "Query transactions with filters. Returns newest first.",
    input: z.strictObject({
      account: AccountRef.optional(),
      month: MonthStr.optional().describe("YYYY-MM"),
      category: z.string().optional().describe("Category name"),
      uncategorized_only: z.boolean().optional(),
      search: z.string().optional().describe("Substring match on description or notes"),
      limit: z.number().int().min(1).max(500).default(50),
    }),
    handler(a) {
      const cond: string[] = [];
      const params: Record<string, string | number> = {};
      if (a.account != null) {
        const account = accountByRef(a.account);
        if (!account) throw new Error(`account not found: ${a.account}`);
        cond.push("t.account_id = @account_id");
        params.account_id = account.id;
      }
      if (a.month) {
        cond.push("substr(t.posted_date, 1, 7) = @month");
        params.month = a.month;
      }
      if (a.category) {
        cond.push("lower(c.name) = lower(@category)");
        params.category = a.category;
      }
      if (a.uncategorized_only) cond.push("t.category_id IS NULL");
      if (a.search) {
        cond.push("(t.description_raw LIKE @search OR t.merchant_norm LIKE @search OR t.notes LIKE @search)");
        params.search = `%${a.search}%`;
      }
      const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
      const stmt = db.prepare(
        `SELECT t.id, t.posted_date, t.description_raw, t.amount_cents, t.is_transfer, t.notes,
                a.name AS account, a.currency, c.name AS category
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id
         ${where}
         ORDER BY t.posted_date DESC, t.id DESC
         LIMIT ${a.limit}`
      );
      return cond.length ? stmt.all(params) : stmt.all();
    },
  }),

  tool({
    name: "set_category",
    description:
      "Set the category of one transaction (by id). Creates a merchant rule so the same merchant is auto-categorized in the future. apply_to_same_merchant also re-categorizes all other transactions of that merchant.",
    input: z.strictObject({
      transaction_id: z.number().int(),
      category: z.string().nullable().describe("Category name, or null to clear"),
      apply_to_same_merchant: z.boolean().optional(),
    }),
    handler(a) {
      const id = a.transaction_id;
      const txn = db.prepare("SELECT * FROM transactions WHERE id = ?").get(id) as
        | { merchant_norm: string }
        | undefined;
      if (!txn) throw new Error(`transaction ${id} not found`);
      let categoryId: number | null = null;
      if (a.category !== null) {
        const cat = categoriesByName().get(a.category.toLowerCase());
        if (!cat) throw new Error(`unknown category "${a.category}" — use list_categories names`);
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
          if (a.apply_to_same_merchant) {
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
  }),

  tool({
    name: "set_note",
    description:
      "Attach a free-text note to a transaction (or null to clear it). Useful when the statement description is cryptic — e.g. what an e-transfer or a generic 'POS PURCHASE' actually was.",
    input: z.strictObject({
      transaction_id: z.number().int(),
      note: z.string().nullable(),
    }),
    handler(a) {
      const id = a.transaction_id;
      const exists = db.prepare("SELECT id FROM transactions WHERE id = ?").get(id);
      if (!exists) throw new Error(`transaction ${id} not found`);
      const note = a.note == null ? null : a.note.trim() || null;
      db.prepare("UPDATE transactions SET notes = ? WHERE id = ?").run(note, id);
      return { updated: true, note };
    },
  }),

  tool({
    name: "mark_transfer",
    description:
      "Mark/unmark a transaction as a transfer between the user's own accounts (excluded from spending stats). Typical: credit-card payments, e-transfers to self.",
    input: z.strictObject({
      transaction_id: z.number().int(),
      is_transfer: z.boolean(),
    }),
    handler(a) {
      const id = a.transaction_id;
      const exists = db.prepare("SELECT id FROM transactions WHERE id = ?").get(id);
      if (!exists) throw new Error(`transaction ${id} not found`);
      if (a.is_transfer) {
        db.prepare("UPDATE transactions SET is_transfer = 1 WHERE id = ?").run(id);
      } else {
        unmarkTransfer(id);
      }
      return { updated: true };
    },
  }),

  tool({
    name: "link_transfer_pair",
    description:
      "Link two transactions (usually in different accounts) as the two sides of one internal transfer — e.g. a credit-card payment and the matching chequing withdrawal. Both are marked as transfers (excluded from spending stats) and linked to each other. Use the transfer_pair_suggestions from get_summary to find candidates.",
    input: z.strictObject({
      transaction_id_a: z.number().int(),
      transaction_id_b: z.number().int(),
      allow_mismatch: z
        .boolean()
        .default(false)
        .describe("Explicitly allow different currencies or non-opposite amounts, e.g. an FX transfer or fee-adjusted transfer"),
    }),
    handler(args) {
      const { a, b, mismatch } = pairTransfer(
        args.transaction_id_a,
        args.transaction_id_b,
        args.allow_mismatch
      );
      const warning = mismatch
        ? "paired with an explicit mismatch override — verify the FX conversion or fees"
        : undefined;
      return { paired: true, a, b, ...(warning ? { warning } : {}) };
    },
  }),

  tool({
    name: "get_summary",
    description:
      "Net worth across all accounts (in CAD) plus spending by category for a month (also converted to CAD). Also lists transfer-pair suggestions (opposite amounts across accounts that look like internal transfers).",
    input: z.strictObject({
      month: MonthStr.optional().describe("YYYY-MM, default current month"),
    }),
    handler(a) {
      const month = a.month ?? currentLocalMonth();
      const nw = netWorth();
      const missingFx = missingFxCurrenciesForRange(month, month);
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
        fx_complete: nw.fx_complete && missingFx.length === 0,
        missing_fx_currencies: [...new Set([...nw.missing_fx_currencies, ...missingFx])].sort(),
        accounts: nw.accounts.map((a) => ({ name: a.name, currency: a.currency, balance_cents: a.balance_cents, balance_cad_cents: a.balance_cad_cents })),
        spending_by_category: spendRows,
        uncategorized_count: uncategorized,
        transfer_pair_suggestions: suggestTransferPairs().slice(0, 10),
      };
    },
  }),

  tool({
    name: "list_imports",
    description: "Import history (batches). Each committed import can be undone.",
    input: z.strictObject({}),
    handler() {
      return db
        .prepare(
          `SELECT i.id, i.file_name, a.name AS account, i.inserted_count, i.skipped_dupes, i.status,
                  i.source, i.statement_start_date, i.statement_end_date,
                  i.statement_balance_cents, i.computed_balance_cents, i.reconciliation_status,
                  datetime(i.created_at, 'unixepoch') AS created_at
           FROM imports i JOIN accounts a ON a.id = i.account_id ORDER BY i.created_at DESC LIMIT 50`
        )
        .all();
    },
  }),

  tool({
    name: "undo_import",
    description: "Undo an import batch: deletes every transaction it inserted.",
    input: z.strictObject({
      import_id: z.number().int(),
    }),
    handler(a) {
      const id = a.import_id;
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
  }),

  tool({
    name: "set_fx_rate",
    description: "Set the exchange rate used to convert a currency to CAD in net-worth summaries (e.g. USD 1.37).",
    input: z.strictObject({
      currency: z.string().length(3).describe("ISO 4217, e.g. USD"),
      rate_to_cad: z.number().positive(),
    }),
    handler(a) {
      const currency = a.currency.toUpperCase();
      db.prepare(
        `INSERT INTO fx_rates (currency, rate_to_cad, updated_at) VALUES (?, ?, unixepoch())
         ON CONFLICT(currency) DO UPDATE SET rate_to_cad = excluded.rate_to_cad, updated_at = unixepoch()`
      ).run(currency, a.rate_to_cad);
      return { currency, rate_to_cad: a.rate_to_cad };
    },
  }),

  tool({
    name: "set_balance_snapshot",
    description:
      "Record an account's balance as of a date. This is THE way to track investment/retirement accounts (Wealthsimple, IBKR, RRSP/TFSA): their market value moves without transactions, so instead of importing a ledger, periodically snapshot the current value — e.g. when the user says 'my Wealthsimple TFSA is at $23,450 now'. The account's balance is anchored on its latest snapshot (+ any transactions after that date), and net worth uses it. Also useful as a reconciliation anchor for cash accounts. Signed integer cents in the account's native currency. Snapshotting the same account+date again overwrites that snapshot.",
    input: z.strictObject({
      account: AccountRef,
      balance_cents: z.number().int().describe("Signed cents; for a liability, money owed is negative"),
      date: DateStr.optional().describe("YYYY-MM-DD the balance refers to; defaults to today"),
      note: z.string().optional().describe("Optional note, e.g. 'after July contribution'"),
    }),
    handler(a) {
      const account = accountByRef(a.account);
      if (!account) throw new Error(`account not found: ${a.account}. Call list_accounts first.`);
      const balance = a.balance_cents;
      const date = a.date ?? currentLocalDate();
      if (account.kind === "liability" && balance > 0) {
        // not an error — but worth flagging, since owed money should be negative
        console.error(`[snapshot] warning: positive snapshot on liability account ${account.name}`);
      }
      db.prepare(
        `INSERT INTO balance_snapshots (account_id, snapshot_date, balance_cents, note) VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id, snapshot_date) DO UPDATE SET balance_cents = excluded.balance_cents, note = excluded.note`
      ).run(account.id, date, balance, a.note ?? null);
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
  }),

  tool({
    name: "list_balance_snapshots",
    description: "Snapshot history for one account (newest first) — shows how its value moved over time.",
    input: z.strictObject({
      account: AccountRef,
      limit: z.number().int().min(1).max(200).default(24),
    }),
    handler(a) {
      const account = accountByRef(a.account);
      if (!account) throw new Error(`account not found: ${a.account}`);
      return db
        .prepare(
          `SELECT snapshot_date, balance_cents, note FROM balance_snapshots
           WHERE account_id = ? ORDER BY snapshot_date DESC LIMIT ${a.limit}`
        )
        .all(account.id);
    },
  }),
];

// ---------- wire up ----------

const server = new Server({ name: "my-money", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: TOOLS.map((t) => {
    const { $schema: _, ...inputSchema } = z.toJSONSchema(t.input, { io: "input" });
    return { name: t.name, description: t.description, inputSchema: inputSchema as { type: "object" } };
  }),
}));

server.setRequestHandler(CallToolRequestSchema, (req) => {
  const t = TOOLS.find((x) => x.name === req.params.name);
  if (!t) return fail(`unknown tool: ${req.params.name}`);
  const parsed = t.input.safeParse(req.params.arguments ?? {});
  if (!parsed.success) return fail(`invalid arguments:\n${z.prettifyError(parsed.error)}`);
  try {
    return ok(t.handler(parsed.data));
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[my-money] MCP server ready (stdio)`);
