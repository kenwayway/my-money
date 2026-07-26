import { parse as parseDate, isValid, format as formatDate } from "date-fns";
import type { ImportSpec } from "@my-money/shared";
import { normalizeMerchant } from "../services/categorizer.js";

export interface AppliedRow {
  row_index: number; // index into the parsed data rows (after skip/header)
  posted_date: string; // YYYY-MM-DD
  description_raw: string;
  merchant_norm: string;
  amount_cents: number; // signed native: + inflow, - outflow
  balance_cents: number | null;
}

export interface ApplyError {
  row_index: number;
  error: string;
}

export interface ApplyResult {
  rows: AppliedRow[];
  errors: ApplyError[];
  dataRowCount: number;
}

export function parseMoney(cell: string, spec: ImportSpec): number | null {
  let t = cell.trim();
  if (t === "") return null;
  let negative = false;
  if (spec.parentheses_negative && /^\(.*\)$/.test(t)) {
    negative = true;
    t = t.slice(1, -1);
  }
  t = t.replace(/[$€£¥]|CAD|USD|EUR/gi, "").trim();
  if (spec.thousands_separator === ",") t = t.replace(/,/g, "");
  else if (spec.thousands_separator === " ") t = t.replace(/ /g, "");
  if (t.startsWith("-")) {
    negative = !negative ? true : negative;
    t = t.slice(1);
  }
  if (t === "" || !/^\d*\.?\d*$/.test(t)) return null;
  const value = Math.round(parseFloat(t) * 100);
  if (Number.isNaN(value)) return null;
  return negative ? -value : value;
}

/** Apply an ImportSpec to the full parsed CSV. Pure and local — no AI here. */
export function applySpec(allRows: string[][], spec: ImportSpec): ApplyResult {
  const start = spec.skip_rows + (spec.has_header ? 1 : 0);
  const dataRows = allRows.slice(start);
  const rows: AppliedRow[] = [];
  const errors: ApplyError[] = [];

  dataRows.forEach((cells, i) => {
    if (cells.every((c) => c.trim() === "")) return; // blank line
    try {
      const dateCell = (cells[spec.date.column] ?? "").trim();
      const d = parseDate(dateCell, spec.date.format, new Date());
      if (!isValid(d)) throw new Error(`bad date "${dateCell}" for format ${spec.date.format}`);
      const posted_date = formatDate(d, "yyyy-MM-dd");

      const description_raw = spec.description_columns
        .map((c) => (cells[c] ?? "").trim())
        .filter(Boolean)
        .join(" ");

      let amount_cents: number;
      if (spec.amount.mode === "single") {
        const v = parseMoney(cells[spec.amount.column] ?? "", spec);
        if (v === null) throw new Error(`bad amount "${cells[spec.amount.column] ?? ""}"`);
        amount_cents = spec.amount.sign_convention === "outflow_positive" ? -v : v;
      } else {
        const debit = parseMoney(cells[spec.amount.debit_column] ?? "", spec);
        const credit = parseMoney(cells[spec.amount.credit_column] ?? "", spec);
        if (debit === null && credit === null) throw new Error("both debit and credit empty");
        amount_cents = (credit ?? 0) - Math.abs(debit ?? 0);
      }

      let balance_cents: number | null = null;
      if (spec.balance_column !== null) {
        balance_cents = parseMoney(cells[spec.balance_column] ?? "", spec);
      }

      rows.push({
        row_index: i,
        posted_date,
        description_raw: description_raw || "(no description)",
        merchant_norm: normalizeMerchant(description_raw) || "(NO DESCRIPTION)",
        amount_cents,
        balance_cents,
      });
    } catch (err) {
      errors.push({ row_index: i, error: err instanceof Error ? err.message : String(err) });
    }
  });

  return { rows, errors, dataRowCount: dataRows.filter((r) => !r.every((c) => c.trim() === "")).length };
}
