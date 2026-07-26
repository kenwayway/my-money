export type AccountType =
  | "chequing"
  | "savings"
  | "credit"
  | "prepaid"
  | "cash"
  | "investment";

export type AccountKind = "asset" | "liability";

export interface Account {
  id: number;
  name: string;
  institution: string | null;
  type: AccountType;
  kind: AccountKind;
  currency: string;
  last4: string | null;
  opening_balance_cents: number;
  opening_balance_date: string | null;
  color: string;
  icon: string;
  archived: 0 | 1;
  created_at: number;
}

export interface AccountWithBalance extends Account {
  balance_cents: number;
  balance_cad_cents: number;
  txn_count: number;
  /** Where the balance anchor comes from: a manual snapshot or the opening balance. */
  balance_source: "snapshot" | "opening";
  /** Date of the snapshot anchoring the balance (null when anchored on opening balance). */
  balance_as_of: string | null;
}

export interface BalanceSnapshot {
  id: number;
  account_id: number;
  snapshot_date: string;
  balance_cents: number;
  note: string | null;
  created_at: number;
}

export type CategoryType = "income" | "expense";

export interface Category {
  id: number;
  name: string;
  type: CategoryType;
  color: string;
  icon: string;
  sort_order: number;
  is_system: 0 | 1;
}

export type CategorySource = "rule" | "ai" | "user";

export interface Transaction {
  id: number;
  account_id: number;
  posted_date: string;
  description_raw: string;
  merchant_norm: string;
  amount_cents: number;
  category_id: number | null;
  category_source: CategorySource | null;
  is_transfer: 0 | 1;
  transfer_peer_id: number | null;
  import_id: number | null;
  fingerprint: string;
  notes: string | null;
  created_at: number;
}

export interface ImportRecord {
  id: number;
  account_id: number;
  file_name: string;
  file_sha256: string;
  spec_id: number | null;
  row_count: number;
  inserted_count: number;
  skipped_dupes: number;
  status: "committed" | "undone";
  created_at: number;
}

export interface MerchantRule {
  id: number;
  pattern: string;
  match_type: "exact" | "prefix" | "contains";
  category_id: number;
  source: "ai" | "user";
  created_at: number;
}

export interface FxRate {
  currency: string;
  rate_to_cad: number;
  updated_at: number;
}

export interface NetWorthSummary {
  total_cad_cents: number;
  assets_cad_cents: number;
  liabilities_cad_cents: number;
  accounts: AccountWithBalance[];
}

export interface CategorySpend {
  category_id: number | null;
  category_name: string;
  category_color: string;
  category_icon: string;
  total_cad_cents: number;
  txn_count: number;
}

export interface MonthSpend {
  month: string; // YYYY-MM
  expense_cad_cents: number;
  income_cad_cents: number;
}

export interface SpendingSummary {
  month: string;
  by_category: CategorySpend[];
  trend: MonthSpend[];
  uncategorized_count: number;
}

/** A parsed transaction row from a CSV, before it becomes a DB transaction. */
export interface ParsedTxn {
  row_index: number;
  posted_date: string;
  description_raw: string;
  merchant_norm: string;
  amount_cents: number;
  fingerprint: string;
  duplicate: boolean;
  category_id: number | null;
  category_source: CategorySource | null;
  category_name?: string | null;
}

export interface AnalyzeResult {
  staging_token: string;
  file_name: string;
  file_sha256: string;
  file_already_imported: boolean;
  spec: unknown; // ImportSpec — typed via importSpec.ts
  spec_source: "cache" | "ai" | "manual";
  bank_guess: string | null;
  columns_preview: string[][]; // first raw rows for the mapping editor
  rows: ParsedTxn[];
  new_count: number;
  duplicate_count: number;
  parse_errors: { row_index: number; error: string }[];
  validation: { ok: boolean; parse_rate: number; balance_check: "ok" | "failed" | "n/a"; message?: string };
}
