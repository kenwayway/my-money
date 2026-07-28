import {
  AlertTriangle,
  ArrowLeftRight,
  BadgeDollarSign,
  CheckCircle2,
  FileCheck2,
  Inbox,
  Loader2,
  RefreshCw,
  Tags,
} from "lucide-react";
import {
  fmtMoney,
  type FinancialInboxSummary,
} from "../api";
import type { TransferPairSuggestion } from "@my-money/shared";

interface Props {
  inbox: FinancialInboxSummary | null;
  pairingId: number | null;
  error: string;
  onNavigate: (page: string) => void;
  onReviewUncategorized: () => void;
  onPairTransfer: (suggestion: TransferPairSuggestion) => void;
}

export default function FinancialInbox({
  inbox,
  pairingId,
  error,
  onNavigate,
  onReviewUncategorized,
  onPairTransfer,
}: Props) {
  return (
    <section className="card financial-inbox">
      <div className="inbox-head">
        <div>
          <div className="inbox-kicker">
            <Inbox size={13} /> Financial inbox
          </div>
          <h2>{inbox?.attention_group_count ? "A few things need your eye" : "Your money is in order"}</h2>
          <p>
            {inbox?.attention_group_count
              ? "Clear these checks and the numbers below become much easier to trust."
              : "No data-quality or account-maintenance issues need attention."}
          </p>
        </div>
        {inbox && (
          <span className={`inbox-count ${inbox.attention_group_count === 0 ? "clear" : ""}`}>
            {inbox.attention_group_count === 0 ? "All clear" : `${inbox.attention_group_count} to review`}
          </span>
        )}
      </div>

      {error && <div className="alert error inbox-error">{error}</div>}

      {!inbox ? (
        <div className="inbox-loading">
          <Loader2 size={16} className="spin" /> Checking your accounts…
        </div>
      ) : inbox.attention_group_count === 0 ? (
        <div className="inbox-clear">
          <span><CheckCircle2 size={20} /></span>
          <div>
            <strong>Nothing waiting.</strong>
            <div>Transactions are categorized, rates are current, and investment values are fresh.</div>
          </div>
        </div>
      ) : (
        <div className="inbox-list">
          {inbox.uncategorized_count > 0 && (
            <div className="inbox-item">
              <span className="inbox-icon warn"><Tags size={17} /></span>
              <div className="inbox-copy">
                <strong>{inbox.uncategorized_count} uncategorized transaction{inbox.uncategorized_count === 1 ? "" : "s"}</strong>
                <span>Review them once; merchant rules will handle familiar names next time.</span>
              </div>
              <button onClick={onReviewUncategorized}>Review</button>
            </div>
          )}

          {(inbox.unreconciled_statement_count > 0 || inbox.mismatched_statement_count > 0) && (
            <div className="inbox-item">
              <span className={`inbox-icon ${inbox.mismatched_statement_count > 0 ? "danger" : "warn"}`}>
                <FileCheck2 size={17} />
              </span>
              <div className="inbox-copy">
                <strong>
                  {inbox.mismatched_statement_count > 0
                    ? `${inbox.mismatched_statement_count} statement${inbox.mismatched_statement_count === 1 ? "" : "s"} have a balance mismatch`
                    : `${inbox.unreconciled_statement_count} statement${inbox.unreconciled_statement_count === 1 ? "" : "s"} not reconciled`}
                </strong>
                <span>
                  {inbox.mismatched_statement_count > 0 && inbox.unreconciled_statement_count > 0
                    ? `${inbox.unreconciled_statement_count} more still need a closing-balance check.`
                    : "Compare the ledger with the bank's closing balance to establish trust."}
                </span>
              </div>
              <button onClick={() => onNavigate("statements")}>Review</button>
            </div>
          )}

          {inbox.missing_fx_currencies.length > 0 && (
            <div className="inbox-item">
              <span className="inbox-icon danger"><BadgeDollarSign size={17} /></span>
              <div className="inbox-copy">
                <strong>Missing FX rate{inbox.missing_fx_currencies.length === 1 ? "" : "s"}</strong>
                <span>
                  {inbox.missing_fx_currencies.join(", ")} cannot be included in CAD totals yet.
                </span>
              </div>
              <button onClick={() => onNavigate("settings")}>Set rates</button>
            </div>
          )}

          {inbox.stale_fx_rates.length > 0 && (
            <div className="inbox-item">
              <span className="inbox-icon warn"><RefreshCw size={17} /></span>
              <div className="inbox-copy">
                <strong>{inbox.stale_fx_rates.length} stale FX rate{inbox.stale_fx_rates.length === 1 ? "" : "s"}</strong>
                <span>
                  {inbox.stale_fx_rates.map((r) => `${r.currency} · ${r.days_since_update}d`).join("  •  ")}
                </span>
              </div>
              <button onClick={() => onNavigate("settings")}>Update</button>
            </div>
          )}

          {inbox.stale_investment_accounts.length > 0 && (
            <div className="inbox-item">
              <span className="inbox-icon warn"><AlertTriangle size={17} /></span>
              <div className="inbox-copy">
                <strong>
                  {inbox.stale_investment_accounts.length} investment value
                  {inbox.stale_investment_accounts.length === 1 ? "" : "s"} need an update
                </strong>
                <span>
                  {inbox.stale_investment_accounts
                    .map((a) => `${a.account_name} · ${a.days_since_snapshot === null ? "never updated" : `${a.days_since_snapshot}d old`}`)
                    .join("  •  ")}
                </span>
              </div>
              <button onClick={() => onNavigate("accounts")}>Update</button>
            </div>
          )}

          {inbox.transfer_suggestion_count > 0 && (
            <div className="inbox-item inbox-transfer-group">
              <span className="inbox-icon info"><ArrowLeftRight size={17} /></span>
              <div className="inbox-copy">
                <strong>
                  {inbox.transfer_suggestion_count} possible transfer pair
                  {inbox.transfer_suggestion_count === 1 ? "" : "s"}
                </strong>
                <span>Matching movements across your own accounts should not count as spending.</span>
                <div className="transfer-candidates">
                  {inbox.transfer_suggestions.map((suggestion) => (
                    <div className="transfer-candidate" key={`${suggestion.a.id}-${suggestion.b.id}`}>
                      <div>
                        <span>{suggestion.a.posted_date}</span>
                        <strong>{suggestion.a.account_name}</strong>
                        <span className="money">{fmtMoney(suggestion.a.amount_cents, suggestion.a.currency, true)}</span>
                      </div>
                      <ArrowLeftRight size={13} />
                      <div>
                        <span>{suggestion.b.posted_date}</span>
                        <strong>{suggestion.b.account_name}</strong>
                        <span className="money">{fmtMoney(suggestion.b.amount_cents, suggestion.b.currency, true)}</span>
                      </div>
                      <button
                        className="primary"
                        disabled={pairingId !== null}
                        onClick={() => onPairTransfer(suggestion)}
                      >
                        {pairingId === suggestion.a.id ? <Loader2 size={13} className="spin" /> : "Link"}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
