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
  /** null when a non-CAD account has no configured FX rate. */
  balance_cad_cents: number | null;
  fx_rate_to_cad: number | null;
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
  source: "web" | "mcp";
  statement_start_date: string | null;
  statement_end_date: string | null;
  statement_balance_cents: number | null;
  computed_balance_cents: number | null;
  reconciliation_status: "not_checked" | "matched" | "mismatch";
  validation_status: "not_checked" | "passed" | "failed";
  created_at: number;
}

export interface StatementRecord extends ImportRecord {
  account_name: string;
  account_currency: string;
  account_color: string;
  account_type: AccountType;
  institution: string | null;
  active_transaction_count: number;
  difference_cents: number | null;
}

export interface StatementTransaction {
  id: number;
  posted_date: string;
  description_raw: string;
  amount_cents: number;
  category_name: string | null;
  is_transfer: 0 | 1;
  notes: string | null;
}

export interface StatementDetail {
  statement: StatementRecord;
  transactions: StatementTransaction[];
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
  /** Aggregate totals are null rather than silently wrong when FX is missing. */
  total_cad_cents: number | null;
  assets_cad_cents: number | null;
  liabilities_cad_cents: number | null;
  fx_complete: boolean;
  missing_fx_currencies: string[];
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
  fx_complete: boolean;
  missing_fx_currencies: string[];
}

export interface TransferPairSide {
  id: number;
  account_id: number;
  account_name: string;
  currency: string;
  posted_date: string;
  description_raw: string;
  amount_cents: number;
}

export interface TransferPairSuggestion {
  a: TransferPairSide;
  b: TransferPairSide;
}

export interface StaleInvestmentAccount {
  account_id: number;
  account_name: string;
  currency: string;
  last_snapshot_date: string | null;
  days_since_snapshot: number | null;
}

export interface StaleFxRate {
  currency: string;
  updated_at: number;
  days_since_update: number;
}

export interface FinancialInboxSummary {
  attention_group_count: number;
  uncategorized_count: number;
  unreconciled_statement_count: number;
  mismatched_statement_count: number;
  transfer_suggestion_count: number;
  transfer_suggestions: TransferPairSuggestion[];
  missing_fx_currencies: string[];
  stale_fx_rates: StaleFxRate[];
  stale_investment_accounts: StaleInvestmentAccount[];
}
