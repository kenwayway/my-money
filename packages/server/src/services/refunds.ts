import { db, tx } from "../db/connection.js";

export interface RefundPairSide {
  id: number;
  account_id: number;
  account_name: string;
  currency: string;
  posted_date: string;
  description_raw: string;
  amount_cents: number;
  is_transfer: 0 | 1;
  transfer_peer_id: number | null;
  refund_peer_id: number | null;
}

function refundSide(id: number): RefundPairSide | undefined {
  return db.prepare(
    `SELECT t.id, t.account_id, a.name AS account_name, a.currency,
            t.posted_date, t.description_raw, t.amount_cents, t.is_transfer,
            t.transfer_peer_id, t.refund_peer_id
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     WHERE t.id = ?`
  ).get(id) as RefundPairSide | undefined;
}

function dissolveExistingPair(side: RefundPairSide, keepA: number, keepB: number): void {
  if (side.refund_peer_id === null || side.refund_peer_id === keepA || side.refund_peer_id === keepB) return;
  db.prepare(
    `UPDATE transactions
     SET refund_peer_id = NULL
     WHERE id = ? AND refund_peer_id = ?`
  ).run(side.refund_peer_id, side.id);
}

/**
 * Link one positive refund/reimbursement to one negative expense. Partial
 * refunds are allowed; over-refunds and cross-currency pairs are not.
 */
export function pairRefund(
  expenseId: number,
  refundId: number
): { expense: RefundPairSide; refund: RefundPairSide } {
  if (expenseId === refundId) throw new Error("cannot pair a transaction with itself");

  const expense = refundSide(expenseId);
  const refund = refundSide(refundId);
  if (!expense) throw new Error(`transaction ${expenseId} not found`);
  if (!refund) throw new Error(`transaction ${refundId} not found`);
  if (expense.amount_cents >= 0) throw new Error("the original expense must have a negative amount");
  if (refund.amount_cents <= 0) throw new Error("the refund must have a positive amount");
  if (expense.currency !== refund.currency) throw new Error("refund and expense must use the same currency");
  if (refund.amount_cents > -expense.amount_cents) {
    throw new Error("refund cannot be greater than the original expense");
  }
  if (expense.is_transfer || refund.is_transfer || expense.transfer_peer_id !== null || refund.transfer_peer_id !== null) {
    throw new Error("a transfer cannot also be paired as a refund");
  }

  tx(() => {
    dissolveExistingPair(expense, expenseId, refundId);
    dissolveExistingPair(refund, expenseId, refundId);
    db.prepare("UPDATE transactions SET refund_peer_id = ? WHERE id = ?").run(refundId, expenseId);
    db.prepare("UPDATE transactions SET refund_peer_id = ? WHERE id = ?").run(expenseId, refundId);
  });

  return {
    expense: refundSide(expenseId)!,
    refund: refundSide(refundId)!,
  };
}

function unpairRefundUpdates(id: number): void {
  const row = db.prepare("SELECT refund_peer_id FROM transactions WHERE id = ?").get(id) as
    | { refund_peer_id: number | null }
    | undefined;
  if (!row) throw new Error(`transaction ${id} not found`);
  db.prepare("UPDATE transactions SET refund_peer_id = NULL WHERE id = ?").run(id);
  if (row.refund_peer_id !== null) {
    db.prepare(
      `UPDATE transactions
       SET refund_peer_id = NULL
       WHERE id = ? AND refund_peer_id = ?`
    ).run(row.refund_peer_id, id);
  }
}

export function unpairRefund(id: number): void {
  tx(() => unpairRefundUpdates(id));
}

export function unpairRefundInTransaction(id: number): void {
  unpairRefundUpdates(id);
}

/** Likely original expenses for a positive refund, closest dates first. */
export function refundCandidates(refundId: number): RefundPairSide[] {
  const refund = refundSide(refundId);
  if (!refund) throw new Error(`transaction ${refundId} not found`);
  if (refund.amount_cents <= 0) throw new Error("refund must have a positive amount");
  if (refund.is_transfer || refund.transfer_peer_id !== null) throw new Error("transfer transactions cannot be refunds");

  return db.prepare(
    `SELECT t.id, t.account_id, a.name AS account_name, a.currency,
            t.posted_date, t.description_raw, t.amount_cents, t.is_transfer,
            t.transfer_peer_id, t.refund_peer_id
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.id != ?
       AND t.amount_cents < 0
       AND -t.amount_cents >= ?
       AND a.currency = ?
       AND t.is_transfer = 0
       AND t.transfer_peer_id IS NULL
       AND t.refund_peer_id IS NULL
       AND (c.type IS NULL OR c.type != 'transfer')
     ORDER BY ABS(julianday(t.posted_date) - julianday(?)), t.posted_date DESC
     LIMIT 50`
  ).all(refund.id, refund.amount_cents, refund.currency, refund.posted_date) as unknown as RefundPairSide[];
}
