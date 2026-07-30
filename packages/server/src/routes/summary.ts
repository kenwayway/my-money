import { Hono } from "hono";
import { db } from "../db/connection.js";
import { netWorth } from "../services/balances.js";
import { suggestTransferPairs } from "../services/transfers.js";
import { financialInbox } from "../services/inbox.js";
import {
  currentLocalMonth,
  fxRatesByAccount,
  missingFxCurrenciesForRange,
  monthlySpendingByCategory,
} from "../services/spending.js";
import type { MonthSpend } from "@my-money/shared";

export const summaryRoute = new Hono()
  .get("/net-worth", (c) => c.json(netWorth()))
  .get("/inbox", (c) => c.json(financialInbox()))
  .get("/spending", (c) => {
    const month = c.req.query("month") ?? currentLocalMonth();

    // Per-account fx rates applied in JS (few accounts; keeps SQL simple)
    const rateByAccount = fxRatesByAccount();
    const byCategory = monthlySpendingByCategory(month, rateByAccount);

    // 6-month trend: expenses vs income
    const months: string[] = [];
    const [y, m] = month.split("-").map(Number);
    for (let i = 5; i >= 0; i--) {
      const d = new Date(y!, m! - 1 - i, 1);
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
    const missingFx = missingFxCurrenciesForRange(months[0]!, months[months.length - 1]!);
    const trendRows = db
      .prepare(
        `SELECT t.account_id, substr(t.posted_date, 1, 7) AS ym,
                SUM(
                  CASE WHEN t.amount_cents < 0
                    THEN -t.amount_cents
                      - CASE WHEN refund.amount_cents > 0 THEN refund.amount_cents ELSE 0 END
                    ELSE 0
                  END
                ) AS expense,
                SUM(
                  CASE WHEN t.amount_cents > 0 AND refund.id IS NULL
                    THEN t.amount_cents
                    ELSE 0
                  END
                ) AS income
         FROM transactions t
         LEFT JOIN transactions refund
           ON refund.id = t.refund_peer_id AND refund.refund_peer_id = t.id
         LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.is_transfer = 0 AND (c.type IS NULL OR c.type != 'transfer')
           AND substr(t.posted_date, 1, 7) >= ? AND substr(t.posted_date, 1, 7) <= ?
         GROUP BY t.account_id, ym`
      )
      .all(months[0]!, months[months.length - 1]!) as {
      account_id: number;
      ym: string;
      expense: number;
      income: number;
    }[];

    const trend: MonthSpend[] = months.map((ym) => {
      let expense = 0;
      let income = 0;
      for (const r of trendRows) {
        if (r.ym !== ym) continue;
        const rate = rateByAccount.get(r.account_id);
        if (rate == null) continue;
        expense += Math.round(r.expense * rate);
        income += Math.round(r.income * rate);
      }
      return { month: ym, expense_cad_cents: expense, income_cad_cents: income };
    });
    const categoryTrend = months.flatMap((ym) =>
      monthlySpendingByCategory(ym, rateByAccount).map((category) => ({
        month: ym,
        ...category,
      }))
    );

    const uncategorized = (
      db.prepare(
        `SELECT COUNT(*) AS n
         FROM transactions
         WHERE category_id IS NULL
           AND is_transfer = 0
           AND NOT (amount_cents > 0 AND refund_peer_id IS NOT NULL)`
      ).get() as {
        n: number;
      }
    ).n;

    return c.json({
      month,
      by_category: byCategory,
      trend,
      category_trend: categoryTrend,
      uncategorized_count: uncategorized,
      fx_complete: missingFx.length === 0,
      missing_fx_currencies: missingFx,
    });
  })
  .get("/transfer-suggestions", (c) => c.json(suggestTransferPairs()));
