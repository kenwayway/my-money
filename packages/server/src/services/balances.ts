import { db } from "../db/connection.js";
import type { Account, AccountWithBalance, NetWorthSummary } from "@my-money/shared";

export function fxRateToCad(currency: string): number | null {
  if (currency === "CAD") return 1;
  const row = db.prepare("SELECT rate_to_cad FROM fx_rates WHERE currency = ?").get(currency) as
    | { rate_to_cad: number }
    | undefined;
  return row?.rate_to_cad ?? null;
}

interface Anchor {
  balance_cents: number;
  date: string | null;
  source: "snapshot" | "opening";
}

/**
 * The balance anchor for an account: the latest balance snapshot when one
 * exists (optionally capped at `maxDate`), else the opening balance. The
 * account balance is always `anchor + Σ transactions after the anchor date` —
 * for investment accounts (which have no transaction ledger) that means the
 * balance simply IS the latest snapshot.
 */
function anchorFor(account: Account, maxDate?: string): Anchor {
  const snap = db
    .prepare(
      `SELECT snapshot_date, balance_cents FROM balance_snapshots
       WHERE account_id = ? AND (? IS NULL OR snapshot_date <= ?)
       ORDER BY snapshot_date DESC LIMIT 1`
    )
    .get(account.id, maxDate ?? null, maxDate ?? null) as
    | { snapshot_date: string; balance_cents: number }
    | undefined;
  if (snap) return { balance_cents: snap.balance_cents, date: snap.snapshot_date, source: "snapshot" };
  return { balance_cents: account.opening_balance_cents, date: account.opening_balance_date, source: "opening" };
}

export function accountBalance(account: Account): {
  balance_cents: number;
  txn_count: number;
  balance_source: "snapshot" | "opening";
  balance_as_of: string | null;
} {
  const anchor = anchorFor(account);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS s, COUNT(*) AS c
       FROM transactions
       WHERE account_id = ? AND (? IS NULL OR posted_date > ?)`
    )
    .get(account.id, anchor.date, anchor.date) as { s: number; c: number };
  return {
    balance_cents: anchor.balance_cents + row.s,
    txn_count: row.c,
    balance_source: anchor.source,
    balance_as_of: anchor.source === "snapshot" ? anchor.date : null,
  };
}

/** Balance at end of `date` (inclusive): nearest anchor at or before `date` + transactions in between. */
export function balanceAsOf(account: Account, date: string): number {
  const anchor = anchorFor(account, date);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS s
       FROM transactions
       WHERE account_id = ? AND posted_date <= ? AND (? IS NULL OR posted_date > ?)`
    )
    .get(account.id, date, anchor.date, anchor.date) as { s: number };
  return anchor.balance_cents + row.s;
}

export function withBalance(account: Account): AccountWithBalance {
  const { balance_cents, txn_count, balance_source, balance_as_of } = accountBalance(account);
  const rate = fxRateToCad(account.currency);
  return {
    ...account,
    balance_cents,
    balance_cad_cents: rate === null ? null : Math.round(balance_cents * rate),
    fx_rate_to_cad: rate,
    txn_count,
    balance_source,
    balance_as_of,
  };
}

export function netWorth(): NetWorthSummary {
  const accounts = (db.prepare("SELECT * FROM accounts WHERE archived = 0 ORDER BY created_at").all() as unknown as Account[]).map(
    withBalance
  );
  const missing = [...new Set(accounts.filter((a) => a.fx_rate_to_cad === null).map((a) => a.currency))].sort();
  let assets = 0;
  let liabilities = 0;
  for (const a of accounts) {
    if (a.balance_cad_cents === null) continue;
    if (a.kind === "asset") assets += a.balance_cad_cents;
    else liabilities += a.balance_cad_cents; // liability balances are naturally negative
  }
  const complete = missing.length === 0;
  return {
    total_cad_cents: complete ? assets + liabilities : null,
    assets_cad_cents: complete ? assets : null,
    liabilities_cad_cents: complete ? liabilities : null,
    fx_complete: complete,
    missing_fx_currencies: missing,
    accounts,
  };
}
