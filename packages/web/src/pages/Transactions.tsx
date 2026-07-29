import { useCallback, useEffect, useState } from "react";
import { ArrowLeftRight, Search, Sparkles, Loader2, StickyNote, RotateCcw } from "lucide-react";
import { api, fmtMoney, type AccountWithBalance, type Category, type TxnRow } from "../api";
import { catEmoji } from "../categoryIcons";
import MonthPicker from "../components/MonthPicker";

interface Filters {
  account_id: string;
  month: string;
  /** category id as string, "" for all, or "uncat" for uncategorized-only */
  category_id: string;
  q: string;
}

interface RefundCandidate {
  id: number;
  account_id: number;
  account_name: string;
  currency: string;
  posted_date: string;
  description_raw: string;
  amount_cents: number;
}

function initialFilters(): Filters {
  const base: Filters = { account_id: "", month: "", category_id: "", q: "" };
  const raw = sessionStorage.getItem("txn-prefill");
  if (raw) {
    sessionStorage.removeItem("txn-prefill");
    try {
      const p = JSON.parse(raw) as Partial<Filters>;
      return { ...base, category_id: p.category_id ?? "", month: p.month ?? "" };
    } catch {
      /* ignore bad prefill */
    }
  }
  return base;
}

export default function Transactions() {
  const [rows, setRows] = useState<TxnRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [accounts, setAccounts] = useState<AccountWithBalance[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [picker, setPicker] = useState<TxnRow | null>(null);
  const [noteEdit, setNoteEdit] = useState<TxnRow | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [refundPicker, setRefundPicker] = useState<TxnRow | null>(null);
  const [refundCandidates, setRefundCandidates] = useState<RefundCandidate[]>([]);
  const [refundLoading, setRefundLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState("");
  const limit = 100;

  useEffect(() => {
    api.get<AccountWithBalance[]>("/accounts").then(setAccounts).catch(console.error);
    api.get<Category[]>("/categories").then(setCategories).catch(console.error);
  }, []);

  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (filters.account_id) p.set("account_id", filters.account_id);
    if (filters.month) {
      p.set("from", `${filters.month}-01`);
      p.set("to", `${filters.month}-31`);
    }
    if (filters.category_id === "uncat") p.set("uncategorized", "1");
    else if (filters.category_id) p.set("category_id", filters.category_id);
    if (filters.q) p.set("q", filters.q);
    p.set("limit", String(limit));
    p.set("offset", String(offset));
    api
      .get<{ rows: TxnRow[]; total: number }>(`/transactions?${p}`)
      .then((r) => {
        setRows(r.rows);
        setTotal(r.total);
      })
      .catch(console.error);
  }, [filters, offset]);

  useEffect(() => {
    load();
  }, [load]);

  const setCategory = async (txn: TxnRow, categoryId: number | null) => {
    // does the user want to bulk-apply?
    let applyAll = false;
    if (categoryId !== null) {
      const { count } = await api.get<{ count: number }>(`/transactions/${txn.id}/same-merchant-count`);
      if (count > 0) {
        applyAll = confirm(`Apply this category to ${count} other "${txn.merchant_norm}" transaction${count > 1 ? "s" : ""} too?`);
      }
    }
    await api.patch(`/transactions/${txn.id}`, { category_id: categoryId, apply_to_same_merchant: applyAll });
    setPicker(null);
    load();
  };

  const openNote = (txn: TxnRow) => {
    setNoteDraft(txn.notes ?? "");
    setNoteEdit(txn);
  };

  const saveNote = async () => {
    if (!noteEdit) return;
    await api.patch(`/transactions/${noteEdit.id}`, { notes: noteDraft.trim() || null });
    setNoteEdit(null);
    load();
  };

  const toggleTransfer = async (txn: TxnRow) => {
    await api.patch(`/transactions/${txn.id}`, { is_transfer: txn.is_transfer ? 0 : 1 });
    load();
  };

  const openRefundPicker = async (txn: TxnRow) => {
    setRefundPicker(txn);
    setRefundCandidates([]);
    setRefundLoading(true);
    setNotice("");
    try {
      setRefundCandidates(await api.get<RefundCandidate[]>(`/transactions/${txn.id}/refund-candidates`));
    } catch (e) {
      setNotice(`Could not load refund candidates: ${e instanceof Error ? e.message : e}`);
      setRefundPicker(null);
    } finally {
      setRefundLoading(false);
    }
  };

  const pairRefund = async (expense: RefundCandidate) => {
    if (!refundPicker) return;
    await api.post("/transactions/pair-refund", {
      expense_id: expense.id,
      refund_id: refundPicker.id,
    });
    setRefundPicker(null);
    setNotice(
      `Refund linked. ${fmtMoney(refundPicker.amount_cents, refundPicker.account_currency)} will offset "${expense.description_raw}".`
    );
    load();
  };

  const unpairRefund = async (txn: TxnRow) => {
    if (!confirm("Unlink this refund? Spending totals will be recalculated.")) return;
    await api.del(`/transactions/${txn.id}/refund-pair`);
    setNotice("Refund unlinked.");
    load();
  };

  const runCategorize = async () => {
    setRunning(true);
    setNotice("");
    try {
      const r = await api.post<{ updated: number; remaining: number }>("/categorize/run");
      setNotice(`Applied merchant rules to ${r.updated} transactions; ${r.remaining ?? 0} left for review.`);
      load();
    } catch (e) {
      setNotice(`Categorization failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Transactions</h1>
        <button className="primary" onClick={runCategorize} disabled={running} title="Apply learned merchant rules to uncategorized transactions">
          {running ? <Loader2 size={14} className="spin" style={{ verticalAlign: -2 }} /> : <Sparkles size={14} style={{ verticalAlign: -2 }} />}{" "}
          Apply rules
        </button>
      </div>

      {notice && <div className="alert info">{notice}</div>}

      <div className="card" style={{ marginBottom: 14, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <select value={filters.account_id} onChange={(e) => { setOffset(0); setFilters({ ...filters, account_id: e.target.value }); }}>
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <MonthPicker value={filters.month} onChange={(m) => { setOffset(0); setFilters({ ...filters, month: m }); }} allowEmpty />
        <select value={filters.category_id} onChange={(e) => { setOffset(0); setFilters({ ...filters, category_id: e.target.value }); }}>
          <option value="">All categories</option>
          <option value="uncat">Uncategorized</option>
          {categories
            .filter((c) => c.name !== "Uncategorized")
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
        <div style={{ position: "relative", marginLeft: "auto" }}>
          <Search size={14} style={{ position: "absolute", left: 9, top: 9, color: "var(--text-faint)" }} />
          <input
            style={{ paddingLeft: 28 }}
            placeholder="Search description / notes…"
            value={filters.q}
            onChange={(e) => { setOffset(0); setFilters({ ...filters, q: e.target.value }); }}
          />
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Description</th>
              <th>Account</th>
              <th>Category</th>
              <th style={{ textAlign: "right" }}>Amount</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr
                key={t.id}
                style={t.is_transfer || (t.amount_cents > 0 && t.refund_peer_id !== null) ? { opacity: 0.55 } : undefined}
              >
                <td className="dim" style={{ whiteSpace: "nowrap" }}>{t.posted_date}</td>
                <td title={t.description_raw} style={{ maxWidth: 320 }}>
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.description_raw}
                    {t.is_transfer === 1 && <span className="badge" style={{ marginLeft: 6 }}>transfer</span>}
                    {t.refund_peer_id !== null && (
                      <span className="badge" style={{ marginLeft: 6 }}>
                        {t.amount_cents > 0 ? "refund" : "refunded"}
                      </span>
                    )}
                  </div>
                  {t.notes && (
                    <div className="faint" style={{ fontSize: 12, fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.notes}>
                      {t.notes}
                    </div>
                  )}
                </td>
                <td className="dim">{t.account_name}</td>
                <td>
                  <button className="chip" style={t.category_color ? { background: `${t.category_color}22`, color: t.category_color } : {}} onClick={() => setPicker(t)}>
                    {t.category_name ? `${catEmoji(t.category_icon)} ${t.category_name}` : "— pick —"}
                  </button>
                </td>
                <td className={`money ${t.amount_cents < 0 ? "" : "pos"}`} style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  {fmtMoney(t.amount_cents, t.account_currency, true)}
                  {t.amount_cents < 0 && t.refund_peer_amount_cents !== null && (
                    <div className="faint" style={{ fontSize: 11 }}>
                      net {fmtMoney(t.amount_cents + t.refund_peer_amount_cents, t.account_currency, true)}
                    </div>
                  )}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button
                    title={t.notes ? `Edit note: ${t.notes}` : "Add note"}
                    style={{ padding: "3px 7px", ...(t.notes ? { color: "var(--accent, #6366f1)" } : {}) }}
                    onClick={() => openNote(t)}
                  >
                    <StickyNote size={12} />
                  </button>{" "}
                  <button title={t.is_transfer ? "Unmark transfer" : "Mark as transfer (excluded from spending)"} style={{ padding: "3px 7px" }} onClick={() => toggleTransfer(t)}>
                    <ArrowLeftRight size={12} />
                  </button>
                  {t.refund_peer_id !== null ? (
                    <>
                      {" "}
                      <button
                        title={`Unlink refund${t.refund_peer_description ? `: ${t.refund_peer_description}` : ""}`}
                        style={{ padding: "3px 7px", color: "var(--accent, #6366f1)" }}
                        onClick={() => unpairRefund(t)}
                      >
                        <RotateCcw size={12} />
                      </button>
                    </>
                  ) : t.amount_cents > 0 && !t.is_transfer ? (
                    <>
                      {" "}
                      <button
                        title="Link as a refund or reimbursement"
                        style={{ padding: "3px 7px" }}
                        onClick={() => openRefundPicker(t)}
                      >
                        <RotateCcw size={12} />
                      </button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="empty-state">No transactions match.</div>}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, alignItems: "center" }}>
        <span className="faint">
          {total} transactions · showing {offset + 1}–{Math.min(offset + limit, total)}
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
            ← Prev
          </button>
          <button disabled={offset + limit >= total} onClick={() => setOffset(offset + limit)}>
            Next →
          </button>
        </div>
      </div>

      {noteEdit && (
        <div className="modal-backdrop" onClick={() => setNoteEdit(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 6 }}>Note</h2>
            <div className="faint" style={{ marginBottom: 12 }}>
              {noteEdit.posted_date} · {noteEdit.description_raw} · {fmtMoney(noteEdit.amount_cents, noteEdit.account_currency, true)}
            </div>
            <textarea
              autoFocus
              rows={3}
              style={{ width: "100%", resize: "vertical" }}
              placeholder="What was this? e.g. birthday gift for mom"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) saveNote();
                if (e.key === "Escape") setNoteEdit(null);
              }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button onClick={() => setNoteEdit(null)}>Cancel</button>
              <button className="primary" onClick={saveNote}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {refundPicker && (
        <div className="modal-backdrop" onClick={() => setRefundPicker(null)}>
          <div className="modal" style={{ width: "min(680px, calc(100vw - 32px))" }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 6 }}>Link refund</h2>
            <div className="faint" style={{ marginBottom: 12 }}>
              {refundPicker.posted_date} · {refundPicker.description_raw} ·{" "}
              {fmtMoney(refundPicker.amount_cents, refundPicker.account_currency, true)}
            </div>
            {refundLoading ? (
              <div className="empty-state">Loading expenses…</div>
            ) : refundCandidates.length === 0 ? (
              <div className="empty-state">No eligible expenses found in {refundPicker.account_currency}.</div>
            ) : (
              <div style={{ maxHeight: "min(480px, 60vh)", overflowY: "auto" }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Original expense</th>
                      <th>Account</th>
                      <th style={{ textAlign: "right" }}>Amount</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {refundCandidates.map((candidate) => (
                      <tr key={candidate.id}>
                        <td className="dim" style={{ whiteSpace: "nowrap" }}>{candidate.posted_date}</td>
                        <td title={candidate.description_raw} style={{ maxWidth: 280 }}>
                          <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {candidate.description_raw}
                          </div>
                        </td>
                        <td className="dim">{candidate.account_name}</td>
                        <td className="money" style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          {fmtMoney(candidate.amount_cents, candidate.currency, true)}
                        </td>
                        <td>
                          <button className="primary" onClick={() => pairRefund(candidate)}>
                            Link
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
              <button onClick={() => setRefundPicker(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {picker && (
        <div className="modal-backdrop" onClick={() => setPicker(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 6 }}>Category</h2>
            <div className="faint" style={{ marginBottom: 12 }}>{picker.description_raw}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
              {categories.map((c) => (
                <button
                  key={c.id}
                  className="chip"
                  style={{ background: `${c.color}22`, color: c.color, fontWeight: picker.category_id === c.id ? 700 : 500 }}
                  onClick={() => setCategory(picker, c.id)}
                >
                  {catEmoji(c.icon)} {c.name}
                </button>
              ))}
              <button className="chip" onClick={() => setCategory(picker, null)}>
                clear
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
