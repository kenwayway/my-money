import { useCallback, useEffect, useState } from "react";
import { ArrowLeftRight, Search, Sparkles, Loader2 } from "lucide-react";
import { api, fmtMoney, type AccountWithBalance, type Category, type TxnRow } from "../api";

interface Filters {
  account_id: string;
  month: string;
  category_id: string;
  q: string;
  uncategorized: boolean;
}

export default function Transactions() {
  const [rows, setRows] = useState<TxnRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [accounts, setAccounts] = useState<AccountWithBalance[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [filters, setFilters] = useState<Filters>({ account_id: "", month: "", category_id: "", q: "", uncategorized: false });
  const [picker, setPicker] = useState<TxnRow | null>(null);
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
    if (filters.category_id) p.set("category_id", filters.category_id);
    if (filters.q) p.set("q", filters.q);
    if (filters.uncategorized) p.set("uncategorized", "1");
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

  const toggleTransfer = async (txn: TxnRow) => {
    await api.patch(`/transactions/${txn.id}`, { is_transfer: txn.is_transfer ? 0 : 1 });
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
        <input type="month" value={filters.month} onChange={(e) => { setOffset(0); setFilters({ ...filters, month: e.target.value }); }} />
        <select value={filters.category_id} onChange={(e) => { setOffset(0); setFilters({ ...filters, category_id: e.target.value }); }}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <input
            type="checkbox"
            checked={filters.uncategorized}
            onChange={(e) => { setOffset(0); setFilters({ ...filters, uncategorized: e.target.checked }); }}
          />
          Uncategorized only
        </label>
        <div style={{ position: "relative", marginLeft: "auto" }}>
          <Search size={14} style={{ position: "absolute", left: 9, top: 9, color: "var(--text-faint)" }} />
          <input
            style={{ paddingLeft: 28 }}
            placeholder="Search description…"
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
              <tr key={t.id} style={t.is_transfer ? { opacity: 0.55 } : undefined}>
                <td className="dim" style={{ whiteSpace: "nowrap" }}>{t.posted_date}</td>
                <td title={t.description_raw} style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.description_raw}
                  {t.is_transfer === 1 && <span className="badge" style={{ marginLeft: 6 }}>transfer</span>}
                </td>
                <td className="dim">{t.account_name}</td>
                <td>
                  <button className="chip" style={t.category_color ? { background: `${t.category_color}22`, color: t.category_color } : {}} onClick={() => setPicker(t)}>
                    {t.category_name ?? "— pick —"}
                  </button>
                </td>
                <td className={`money ${t.amount_cents < 0 ? "" : "pos"}`} style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  {fmtMoney(t.amount_cents, t.account_currency, true)}
                </td>
                <td>
                  <button title={t.is_transfer ? "Unmark transfer" : "Mark as transfer (excluded from spending)"} style={{ padding: "3px 7px" }} onClick={() => toggleTransfer(t)}>
                    <ArrowLeftRight size={12} />
                  </button>
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
                  {c.name}
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
