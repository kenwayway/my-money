import { db, tx } from "../db/connection.js";
import type { TransferPairSuggestion } from "@my-money/shared";

interface PairSide {
  id: number;
  account_id: number;
  currency: string;
  posted_date: string;
  description_raw: string;
  amount_cents: number;
  transfer_peer_id: number | null;
  refund_peer_id: number | null;
}

/**
 * Link two transactions as the two sides of one internal transfer: both are
 * marked is_transfer and point at each other via transfer_peer_id.
 * Existing pairings are dissolved first so stale third-party links cannot
 * survive. Amount/currency mismatches require an explicit override.
 */
export function pairTransfer(
  idA: number,
  idB: number,
  allowMismatch = false
): { a: PairSide; b: PairSide; mismatch: boolean } {
  if (idA === idB) throw new Error("cannot pair a transaction with itself");
  const get = db.prepare(
    `SELECT t.id, t.account_id, a.currency, t.posted_date, t.description_raw,
            t.amount_cents, t.transfer_peer_id, t.refund_peer_id
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE t.id = ?`
  );
  const a = get.get(idA) as PairSide | undefined;
  const b = get.get(idB) as PairSide | undefined;
  if (!a) throw new Error(`transaction ${idA} not found`);
  if (!b) throw new Error(`transaction ${idB} not found`);
  if (a.account_id === b.account_id) throw new Error("transfer sides must belong to different accounts");
  if (a.refund_peer_id !== null || b.refund_peer_id !== null) {
    throw new Error("a refund pair cannot also be linked as a transfer");
  }
  const mismatch = a.currency !== b.currency || a.amount_cents + b.amount_cents !== 0;
  if (mismatch && !allowMismatch) {
    throw new Error(
      `transfer sides must use the same currency and exact opposite amounts; ` +
        `got ${a.amount_cents} ${a.currency} and ${b.amount_cents} ${b.currency}`
    );
  }

  tx(() => {
    for (const side of [a, b]) {
      if (side.transfer_peer_id !== null && side.transfer_peer_id !== idA && side.transfer_peer_id !== idB) {
        db.prepare(
          `UPDATE transactions SET transfer_peer_id = NULL, is_transfer = 0
           WHERE id = ? AND transfer_peer_id = ?`
        ).run(side.transfer_peer_id, side.id);
      }
    }
    db.prepare("UPDATE transactions SET is_transfer = 1, transfer_peer_id = ? WHERE id = ?").run(idB, idA);
    db.prepare("UPDATE transactions SET is_transfer = 1, transfer_peer_id = ? WHERE id = ?").run(idA, idB);
  });
  return { a, b, mismatch };
}

function unmarkTransferUpdates(id: number): void {
  const row = db.prepare("SELECT transfer_peer_id FROM transactions WHERE id = ?").get(id) as
    | { transfer_peer_id: number | null }
    | undefined;
  if (!row) throw new Error(`transaction ${id} not found`);
  db.prepare("UPDATE transactions SET is_transfer = 0, transfer_peer_id = NULL WHERE id = ?").run(id);
  if (row.transfer_peer_id !== null) {
    db.prepare(
      `UPDATE transactions SET is_transfer = 0, transfer_peer_id = NULL
       WHERE id = ? AND transfer_peer_id = ?`
    ).run(row.transfer_peer_id, id);
  }
}

/** Unmark one transfer and dissolve its reciprocal pair, if present. */
export function unmarkTransfer(id: number): void {
  tx(() => unmarkTransferUpdates(id));
}

/** Same operation for callers that already own a database transaction. */
export function unmarkTransferInTransaction(id: number): void {
  unmarkTransferUpdates(id);
}

const KEYWORDS = ["TRANSFER", "TFR", "E-TRANSFER", "ETRANSFER", "PAYMENT", "PYMT", "PAY BILL", "BILL PAY"];

/**
 * Suggest transfer pairs across accounts: opposite amounts within ±3 days,
 * same currency, not already paired, with transfer-ish keywords on at least
 * one side. Suggestions only — the user confirms in the UI.
 */
export function suggestTransferPairs(): TransferPairSuggestion[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.account_id, a.name AS account_name, a.currency, t.posted_date, t.description_raw, t.merchant_norm, t.amount_cents
       FROM transactions t JOIN accounts a ON a.id = t.account_id
       WHERE t.is_transfer = 0 AND t.transfer_peer_id IS NULL
       ORDER BY t.posted_date DESC
       LIMIT 2000`
    )
    .all() as {
    id: number;
    account_id: number;
    account_name: string;
    currency: string;
    posted_date: string;
    description_raw: string;
    merchant_norm: string;
    amount_cents: number;
  }[];

  const suggestions: TransferPairSuggestion[] = [];
  const used = new Set<number>();

  for (let i = 0; i < rows.length; i++) {
    const a = rows[i]!;
    if (used.has(a.id) || a.amount_cents >= 0) continue; // outflow side anchors the pair
    const keywordy = (s: string) => KEYWORDS.some((k) => s.includes(k));
    for (let j = 0; j < rows.length; j++) {
      const b = rows[j]!;
      if (used.has(b.id) || b.id === a.id) continue;
      if (b.account_id === a.account_id) continue;
      if (b.currency !== a.currency) continue;
      if (b.amount_cents !== -a.amount_cents) continue;
      const dayDiff = Math.abs(
        (new Date(a.posted_date).getTime() - new Date(b.posted_date).getTime()) / 86_400_000
      );
      if (dayDiff > 3) continue;
      if (!keywordy(a.merchant_norm) && !keywordy(b.merchant_norm)) continue;
      suggestions.push({
        a: { id: a.id, account_id: a.account_id, account_name: a.account_name, currency: a.currency, posted_date: a.posted_date, description_raw: a.description_raw, amount_cents: a.amount_cents },
        b: { id: b.id, account_id: b.account_id, account_name: b.account_name, currency: b.currency, posted_date: b.posted_date, description_raw: b.description_raw, amount_cents: b.amount_cents },
      });
      used.add(a.id);
      used.add(b.id);
      break;
    }
  }
  return suggestions.slice(0, 50);
}
