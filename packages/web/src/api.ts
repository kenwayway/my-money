import type {
  AccountWithBalance,
  Category,
  NetWorthSummary,
  SpendingSummary,
  FinancialInboxSummary,
  StatementDetail,
  StatementRecord,
} from "@my-money/shared";

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const body = await res.json();
      msg = body.error ?? msg;
      const err = new Error(msg) as Error & { detail?: unknown; status?: number };
      err.detail = body.detail;
      err.status = res.status;
      throw err;
    } catch (e) {
      if (e instanceof Error && (e as { status?: number }).status) throw e;
      throw new Error(msg);
    }
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => fetch(`/api${path}`).then((r) => j<T>(r)),
  post: <T>(path: string, body?: unknown) =>
    fetch(`/api${path}`, {
      method: "POST",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then((r) => j<T>(r)),
  patch: <T>(path: string, body: unknown) =>
    fetch(`/api${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => j<T>(r)),
  put: <T>(path: string, body: unknown) =>
    fetch(`/api${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => j<T>(r)),
  del: <T>(path: string) => fetch(`/api${path}`, { method: "DELETE" }).then((r) => j<T>(r)),
};

export type {
  AccountWithBalance,
  Category,
  NetWorthSummary,
  SpendingSummary,
  FinancialInboxSummary,
  StatementDetail,
  StatementRecord,
};

export interface TxnRow {
  id: number;
  account_id: number;
  account_name: string;
  account_currency: string;
  posted_date: string;
  description_raw: string;
  merchant_norm: string;
  amount_cents: number;
  category_id: number | null;
  category_name: string | null;
  category_color: string | null;
  category_icon: string | null;
  category_source: string | null;
  is_transfer: 0 | 1;
  notes: string | null;
}

export function fmtMoney(cents: number, currency = "CAD", showSign = false): string {
  const abs = Math.abs(cents) / 100;
  const s = abs.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = cents < 0 ? "-" : showSign ? "+" : "";
  const symbol = currency === "CAD" || currency === "USD" ? "$" : currency === "EUR" ? "€" : currency === "GBP" ? "£" : `${currency} `;
  return `${sign}${symbol}${s}`;
}
