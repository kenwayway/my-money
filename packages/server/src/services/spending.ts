import { format } from "date-fns";
import { db } from "../db/connection.js";
import { fxRateToCad } from "./balances.js";
import type { CategorySpend } from "@my-money/shared";

/** Current month (YYYY-MM) in LOCAL time — toISOString() would flip to the wrong month near midnight. */
export function currentLocalMonth(): string {
  return format(new Date(), "yyyy-MM");
}

export function fxRatesByAccount(): Map<number, number> {
  const accounts = db.prepare("SELECT id, currency FROM accounts").all() as { id: number; currency: string }[];
  return new Map(accounts.map((a) => [a.id, fxRateToCad(a.currency)]));
}

/**
 * Spending per category for one month, converted to CAD per account.
 * Nets refunds against spending within a category; categories that net to an
 * inflow (refund month) are omitted. Transfers and income categories excluded.
 */
export function monthlySpendingByCategory(
  month: string,
  rateByAccount: Map<number, number> = fxRatesByAccount()
): CategorySpend[] {
  const spendRows = db
    .prepare(
      `SELECT t.account_id, t.category_id, c.name AS category_name, c.color AS category_color, c.icon AS category_icon,
              c.type AS category_type, SUM(t.amount_cents) AS total_cents, COUNT(*) AS n
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.is_transfer = 0
         AND substr(t.posted_date, 1, 7) = ?
         AND (c.name IS NULL OR c.name != 'Transfer')
       GROUP BY t.account_id, t.category_id`
    )
    .all(month) as {
    account_id: number;
    category_id: number | null;
    category_name: string | null;
    category_color: string | null;
    category_icon: string | null;
    category_type: string | null;
    total_cents: number;
    n: number;
  }[];

  const byCategory = new Map<string, CategorySpend>();
  for (const r of spendRows) {
    if (r.category_type === "income") continue;
    const cad = Math.round(-r.total_cents * (rateByAccount.get(r.account_id) ?? 1));
    if (cad <= 0) continue;
    const key = String(r.category_id);
    const cur = byCategory.get(key);
    if (cur) {
      cur.total_cad_cents += cad;
      cur.txn_count += r.n;
    } else {
      byCategory.set(key, {
        category_id: r.category_id,
        category_name: r.category_name ?? "Uncategorized",
        category_color: r.category_color ?? "#d4d4d8",
        category_icon: r.category_icon ?? "help-circle",
        total_cad_cents: cad,
        txn_count: r.n,
      });
    }
  }
  return [...byCategory.values()].sort((a, b) => b.total_cad_cents - a.total_cad_cents);
}
