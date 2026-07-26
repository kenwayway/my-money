import { db } from "../db/connection.js";
import type { Account, AccountWithBalance, NetWorthSummary } from "@my-money/shared";

export function fxRateToCad(currency: string): number {
  if (currency === "CAD") return 1;
  const row = db.prepare("SELECT rate_to_cad FROM fx_rates WHERE currency = ?").get(currency) as
    | { rate_to_cad: number }
    | undefined;
  return row?.rate_to_cad ?? 1;
}

export function accountBalance(account: Account): { balance_cents: number; txn_count: number } {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS s, COUNT(*) AS c
       FROM transactions
       WHERE account_id = ? AND (? IS NULL OR posted_date > ?)`
    )
    .get(account.id, account.opening_balance_date, account.opening_balance_date) as { s: number; c: number };
  return { balance_cents: account.opening_balance_cents + row.s, txn_count: row.c };
}

/** Balance at end of `date` (inclusive): opening snapshot + transactions after the opening date up to `date`. */
export function balanceAsOf(account: Account, date: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS s
       FROM transactions
       WHERE account_id = ? AND posted_date <= ? AND (? IS NULL OR posted_date > ?)`
    )
    .get(account.id, date, account.opening_balance_date, account.opening_balance_date) as { s: number };
  return account.opening_balance_cents + row.s;
}

export function withBalance(account: Account): AccountWithBalance {
  const { balance_cents, txn_count } = accountBalance(account);
  const rate = fxRateToCad(account.currency);
  return {
    ...account,
    balance_cents,
    balance_cad_cents: Math.round(balance_cents * rate),
    txn_count,
  };
}

export function netWorth(): NetWorthSummary {
  const accounts = (db.prepare("SELECT * FROM accounts WHERE archived = 0 ORDER BY created_at").all() as unknown as Account[]).map(
    withBalance
  );
  let assets = 0;
  let liabilities = 0;
  for (const a of accounts) {
    if (a.kind === "asset") assets += a.balance_cad_cents;
    else liabilities += a.balance_cad_cents; // liability balances are naturally negative
  }
  return {
    total_cad_cents: assets + liabilities,
    assets_cad_cents: assets,
    liabilities_cad_cents: liabilities,
    accounts,
  };
}
