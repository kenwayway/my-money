import type { ApplyResult } from "./specApply.js";

export interface ValidationResult {
  ok: boolean;
  parse_rate: number;
  balance_check: "ok" | "failed" | "n/a";
  message?: string;
}

const MIN_PARSE_RATE = 0.95;

/**
 * Sanity-check a spec application over the full file.
 *
 * The balance cross-check is the deterministic net for AI sign-convention
 * mistakes: consecutive running balances must differ by the row amount, in
 * either file ordering (newest-first or oldest-first).
 *
 * Direction depends on the account kind: asset accounts (chequing/savings)
 * report a balance that moves WITH the signed amount; credit cards usually
 * report the amount OWED as a positive number, which moves AGAINST our signed
 * amounts (a charge increases the owed balance). So for liabilities we accept
 * either orientation — as long as one of them is consistent, the column
 * mapping and magnitudes are right.
 */
export function validateApply(result: ApplyResult, accountKind: "asset" | "liability" = "asset"): ValidationResult {
  const parseRate = result.dataRowCount === 0 ? 0 : result.rows.length / result.dataRowCount;
  if (result.dataRowCount === 0) {
    return { ok: false, parse_rate: 0, balance_check: "n/a", message: "no data rows found" };
  }
  if (parseRate < MIN_PARSE_RATE) {
    return {
      ok: false,
      parse_rate: parseRate,
      balance_check: "n/a",
      message: `only ${(parseRate * 100).toFixed(0)}% of rows parsed`,
    };
  }

  const withBalance = result.rows.filter((r) => r.balance_cents !== null);
  if (withBalance.length < 3) {
    return { ok: true, parse_rate: parseRate, balance_check: "n/a" };
  }

  // rows are in file order; count consistency for each (direction, orientation)
  let fwdWith = 0; // oldest-first, balance moves with amount
  let bwdWith = 0; // newest-first, balance moves with amount
  let fwdAgainst = 0; // oldest-first, balance moves against amount (owed-positive liabilities)
  let bwdAgainst = 0;
  let comparisons = 0;
  for (let i = 1; i < withBalance.length; i++) {
    const prev = withBalance[i - 1]!;
    const cur = withBalance[i]!;
    comparisons++;
    const fwdDelta = cur.balance_cents! - prev.balance_cents!;
    const bwdDelta = prev.balance_cents! - cur.balance_cents!;
    if (fwdDelta === cur.amount_cents) fwdWith++;
    if (bwdDelta === prev.amount_cents) bwdWith++;
    if (fwdDelta === -cur.amount_cents) fwdAgainst++;
    if (bwdDelta === -prev.amount_cents) bwdAgainst++;
  }
  const candidates = accountKind === "liability" ? [fwdWith, bwdWith, fwdAgainst, bwdAgainst] : [fwdWith, bwdWith];
  const rate = Math.max(...candidates) / comparisons;
  // Same-day ordering quirks can break a few comparisons; require most to hold.
  if (rate >= 0.8) {
    return { ok: true, parse_rate: parseRate, balance_check: "ok" };
  }
  return {
    ok: false,
    parse_rate: parseRate,
    balance_check: "failed",
    message: `running-balance check failed (${(rate * 100).toFixed(0)}% consistent) — the amount sign convention is likely wrong`,
  };
}
