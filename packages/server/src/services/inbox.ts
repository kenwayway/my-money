import { differenceInCalendarDays, parseISO } from "date-fns";
import { db } from "../db/connection.js";
import { currentLocalDate, missingFxCurrenciesForRange } from "./spending.js";
import { netWorth } from "./balances.js";
import { suggestTransferPairs } from "./transfers.js";
import type {
  FinancialInboxSummary,
  StaleFxRate,
  StaleInvestmentAccount,
} from "@my-money/shared";

const STALE_DAYS = 30;
const TRANSFER_PREVIEW_LIMIT = 5;

/** Actionable data-quality and maintenance work for the Dashboard inbox. */
export function financialInbox(): FinancialInboxSummary {
  const uncategorized = (
    db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE category_id IS NULL AND is_transfer = 0").get() as {
      n: number;
    }
  ).n;

  const transferSuggestions = suggestTransferPairs();
  const statementChecks = db
    .prepare(
      `SELECT
         SUM(CASE WHEN reconciliation_status = 'not_checked' THEN 1 ELSE 0 END) AS unchecked,
         SUM(CASE WHEN reconciliation_status = 'mismatch' THEN 1 ELSE 0 END) AS mismatched
       FROM imports
       WHERE status = 'committed'`
    )
    .get() as { unchecked: number | null; mismatched: number | null };
  const unreconciledStatements = statementChecks.unchecked ?? 0;
  const mismatchedStatements = statementChecks.mismatched ?? 0;
  const missingFx = [
    ...new Set([
      ...netWorth().missing_fx_currencies,
      ...missingFxCurrenciesForRange("0000-00", "9999-99"),
    ]),
  ].sort();
  const today = parseISO(currentLocalDate());

  const investmentRows = db
    .prepare(
      `SELECT a.id AS account_id, a.name AS account_name, a.currency,
              MAX(s.snapshot_date) AS last_snapshot_date
       FROM accounts a
       LEFT JOIN balance_snapshots s ON s.account_id = a.id
       WHERE a.archived = 0 AND a.type = 'investment'
       GROUP BY a.id
       ORDER BY a.name`
    )
    .all() as {
    account_id: number;
    account_name: string;
    currency: string;
    last_snapshot_date: string | null;
  }[];

  const staleInvestments: StaleInvestmentAccount[] = investmentRows
    .map((row) => ({
      ...row,
      days_since_snapshot:
        row.last_snapshot_date === null
          ? null
          : Math.max(0, differenceInCalendarDays(today, parseISO(row.last_snapshot_date))),
    }))
    .filter((row) => row.days_since_snapshot === null || row.days_since_snapshot >= STALE_DAYS);

  const fxRows = db
    .prepare(
      `SELECT DISTINCT f.currency, f.updated_at
       FROM fx_rates f
       JOIN accounts a ON a.currency = f.currency
       WHERE a.archived = 0 AND a.currency != 'CAD'
       ORDER BY f.currency`
    )
    .all() as { currency: string; updated_at: number }[];

  const nowSeconds = Math.floor(Date.now() / 1000);
  const staleFx: StaleFxRate[] = fxRows
    .map((row) => ({
      ...row,
      days_since_update: Math.max(0, Math.floor((nowSeconds - row.updated_at) / 86_400)),
    }))
    .filter((row) => row.days_since_update >= STALE_DAYS);

  const attentionGroupCount = [
    uncategorized > 0,
    unreconciledStatements > 0 || mismatchedStatements > 0,
    transferSuggestions.length > 0,
    missingFx.length > 0,
    staleFx.length > 0,
    staleInvestments.length > 0,
  ].filter(Boolean).length;

  return {
    attention_group_count: attentionGroupCount,
    uncategorized_count: uncategorized,
    unreconciled_statement_count: unreconciledStatements,
    mismatched_statement_count: mismatchedStatements,
    transfer_suggestion_count: transferSuggestions.length,
    transfer_suggestions: transferSuggestions.slice(0, TRANSFER_PREVIEW_LIMIT),
    missing_fx_currencies: missingFx,
    stale_fx_rates: staleFx,
    stale_investment_accounts: staleInvestments,
  };
}
