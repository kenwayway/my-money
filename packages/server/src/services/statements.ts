import { db } from "../db/connection.js";
import { balanceAsOf } from "./balances.js";
import type {
  Account,
  StatementDetail,
  StatementRecord,
  StatementTransaction,
} from "@my-money/shared";

const STATEMENT_SELECT = `
  SELECT i.*, a.name AS account_name, a.currency AS account_currency,
         a.color AS account_color, a.type AS account_type, a.institution,
         COALESCE(i.statement_start_date, MIN(t.posted_date)) AS statement_start_date,
         COALESCE(i.statement_end_date, MAX(t.posted_date)) AS statement_end_date,
         COUNT(t.id) AS active_transaction_count
  FROM imports i
  JOIN accounts a ON a.id = i.account_id
  LEFT JOIN transactions t ON t.import_id = i.id
`;

function withDifference(row: Omit<StatementRecord, "difference_cents">): StatementRecord {
  return {
    ...row,
    difference_cents:
      row.computed_balance_cents === null || row.statement_balance_cents === null
        ? null
        : row.computed_balance_cents - row.statement_balance_cents,
  };
}

export function listStatements(): StatementRecord[] {
  const rows = db
    .prepare(
      `${STATEMENT_SELECT}
       GROUP BY i.id
       ORDER BY a.archived, a.name, COALESCE(i.statement_end_date, MAX(t.posted_date), '') DESC, i.created_at DESC`
    )
    .all() as unknown as Omit<StatementRecord, "difference_cents">[];
  return rows.map(withDifference);
}

export function statementById(id: number): StatementRecord | null {
  const row = db
    .prepare(`${STATEMENT_SELECT} WHERE i.id = ? GROUP BY i.id`)
    .get(id) as unknown as Omit<StatementRecord, "difference_cents"> | undefined;
  return row ? withDifference(row) : null;
}

export function statementDetail(id: number): StatementDetail | null {
  const statement = statementById(id);
  if (!statement) return null;
  const transactions = db
    .prepare(
      `SELECT t.id, t.posted_date, t.description_raw, t.amount_cents,
              c.name AS category_name, t.is_transfer, t.notes
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.import_id = ?
       ORDER BY t.posted_date DESC, t.id DESC
       LIMIT 500`
    )
    .all(id) as unknown as StatementTransaction[];
  return { statement, transactions };
}

export function reconcileStatement(
  id: number,
  endDate: string,
  statementBalanceCents: number
): StatementRecord {
  const row = db
    .prepare(
      `SELECT i.status, i.statement_start_date, a.*
       FROM imports i JOIN accounts a ON a.id = i.account_id
       WHERE i.id = ?`
    )
    .get(id) as unknown as (Account & {
    status: "committed" | "undone";
    statement_start_date: string | null;
  }) | undefined;
  if (!row) throw new Error(`statement ${id} not found`);
  if (row.status !== "committed") throw new Error("an undone statement cannot be reconciled");
  if (row.statement_start_date && endDate < row.statement_start_date) {
    throw new Error("statement end date cannot be before its start date");
  }

  const computed = balanceAsOf(row, endDate);
  const status = computed === statementBalanceCents ? "matched" : "mismatch";
  db.prepare(
    `UPDATE imports
     SET statement_end_date = ?, statement_balance_cents = ?,
         computed_balance_cents = ?, reconciliation_status = ?
     WHERE id = ?`
  ).run(endDate, statementBalanceCents, computed, status, id);

  return statementById(id)!;
}
