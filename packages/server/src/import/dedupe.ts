import crypto from "node:crypto";
import { db } from "../db/connection.js";
import type { AppliedRow } from "./specApply.js";

export interface DedupedRow extends AppliedRow {
  fingerprint: string;
  duplicate: boolean;
}

function txnFingerprint(
  accountId: number,
  date: string,
  amountCents: number,
  merchantNorm: string,
  occurrenceIndex: number
): string {
  return crypto
    .createHash("sha256")
    .update(`${accountId}|${date}|${amountCents}|${merchantNorm}|${occurrenceIndex}`)
    .digest("hex");
}

/**
 * Assign fingerprints with occurrence indexes that CONTINUE from what already
 * exists in the DB: if the DB already has 2 identical (date, amount, merchant)
 * rows and the file contains 3, the file's rows get indexes 0,1,2 — the first
 * two collide (duplicates), the third is new. Re-importing an overlapping
 * statement is therefore a clean no-op, while genuinely repeated same-day
 * purchases still coexist.
 */
export function dedupeRows(accountId: number, rows: AppliedRow[]): DedupedRow[] {
  const seenInFile = new Map<string, number>();
  const existingFp = new Set<string>(
    (db.prepare("SELECT fingerprint FROM transactions WHERE account_id = ?").all(accountId) as {
      fingerprint: string;
    }[]).map((r) => r.fingerprint)
  );

  return rows.map((row) => {
    const key = `${row.posted_date}|${row.amount_cents}|${row.merchant_norm}`;
    const idx = seenInFile.get(key) ?? 0;
    seenInFile.set(key, idx + 1);
    const fingerprint = txnFingerprint(accountId, row.posted_date, row.amount_cents, row.merchant_norm, idx);
    return { ...row, fingerprint, duplicate: existingFp.has(fingerprint) };
  });
}
