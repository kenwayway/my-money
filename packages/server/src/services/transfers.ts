import { db, tx } from "../db/connection.js";
import { unpairRefundInTransaction } from "./refunds.js";
import type { TransferPairSuggestion } from "@my-money/shared";

/**
 * Ids of every category typed 'transfer'. The user may keep more than one (e.g.
 * "Credit card payment" alongside "Transfer") and may rename any of them, so
 * transfer-ness is always resolved through the type, never a name.
 */
export function transferCategoryIds(): Set<number> {
  const rows = db.prepare("SELECT id FROM categories WHERE type = 'transfer'").all() as { id: number }[];
  return new Set(rows.map((r) => r.id));
}

export function isTransferCategory(categoryId: number | null): boolean {
  return categoryId !== null && transferCategoryIds().has(categoryId);
}

/** The category stamped on a transaction the user marks as a transfer by hand. */
export function defaultTransferCategoryId(): number | null {
  const row = db
    .prepare(
      `SELECT id FROM categories WHERE type = 'transfer'
       ORDER BY is_system DESC, sort_order, id LIMIT 1`
    )
    .get() as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Mark one transaction as a transfer, keeping its category in lockstep.
 *
 * is_transfer and a transfer-typed category are two encodings of the same fact.
 * If they drift, a transaction counts as spending in one query and not in
 * another, so every write path goes through here. Caller owns the database
 * transaction.
 */
export function markTransferInTransaction(id: number): void {
  const row = db.prepare("SELECT category_id FROM transactions WHERE id = ?").get(id) as
    | { category_id: number | null }
    | undefined;
  if (!row) throw new Error(`transaction ${id} not found`);
  unpairRefundInTransaction(id); // a refund is a real inflow, not an internal move
  // A transfer category the user already picked is more specific — keep it.
  const categoryId = isTransferCategory(row.category_id) ? row.category_id : defaultTransferCategoryId();
  db.prepare("UPDATE transactions SET is_transfer = 1, category_id = ?, category_source = ? WHERE id = ?").run(
    categoryId,
    categoryId === null ? null : "user",
    id
  );
}

/**
 * Reconcile the transfer flag after a category change. Moving a transaction
 * onto a transfer category says "this is not spending"; moving it off says the
 * opposite and dissolves any pairing. Caller owns the database transaction.
 */
export function syncTransferForCategoryChange(id: number, categoryId: number | null): void {
  const row = db.prepare("SELECT is_transfer FROM transactions WHERE id = ?").get(id) as
    | { is_transfer: 0 | 1 }
    | undefined;
  if (!row) return;
  const wantsTransfer = isTransferCategory(categoryId);
  if (wantsTransfer && !row.is_transfer) markTransferInTransaction(id);
  else if (!wantsTransfer && row.is_transfer) unmarkTransferUpdates(id);
}

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
        const orphan = db.prepare("SELECT transfer_peer_id FROM transactions WHERE id = ?").get(side.transfer_peer_id) as
          | { transfer_peer_id: number | null }
          | undefined;
        if (orphan?.transfer_peer_id === side.id) clearTransferOn(side.transfer_peer_id);
      }
    }
    markTransferInTransaction(idA);
    markTransferInTransaction(idB);
    db.prepare("UPDATE transactions SET transfer_peer_id = ? WHERE id = ?").run(idB, idA);
    db.prepare("UPDATE transactions SET transfer_peer_id = ? WHERE id = ?").run(idA, idB);
  });
  return { a, b, mismatch };
}

/**
 * Clear the flag, the pairing, and — to hold the invariant — a category that
 * only made sense while this was a transfer. The transaction becomes
 * uncategorized rather than keeping a "Transfer" label it no longer earns, so
 * it surfaces in the uncategorized queue for the user to say what it really was.
 */
function clearTransferOn(id: number): void {
  const transferIds = [...transferCategoryIds()];
  const placeholders = transferIds.map(() => "?").join(",");
  db.prepare(
    `UPDATE transactions
     SET is_transfer = 0,
         transfer_peer_id = NULL,
         category_id = CASE WHEN category_id IN (${placeholders || "NULL"}) THEN NULL ELSE category_id END,
         category_source = CASE WHEN category_id IN (${placeholders || "NULL"}) THEN NULL ELSE category_source END
     WHERE id = ?`
  ).run(...transferIds, ...transferIds, id);
}

function unmarkTransferUpdates(id: number): void {
  const row = db.prepare("SELECT transfer_peer_id FROM transactions WHERE id = ?").get(id) as
    | { transfer_peer_id: number | null }
    | undefined;
  if (!row) throw new Error(`transaction ${id} not found`);
  clearTransferOn(id);
  if (row.transfer_peer_id !== null) {
    const peer = db.prepare("SELECT transfer_peer_id FROM transactions WHERE id = ?").get(row.transfer_peer_id) as
      | { transfer_peer_id: number | null }
      | undefined;
    if (peer?.transfer_peer_id === id) clearTransferOn(row.transfer_peer_id);
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
