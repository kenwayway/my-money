import { useEffect, useState } from "react";
import { Plus, Pencil, Archive } from "lucide-react";
import { api, fmtMoney, type AccountWithBalance } from "../api";

const TYPES = ["chequing", "savings", "credit", "prepaid", "cash", "investment"] as const;
const COLORS = ["#4f46e5", "#0ea5e9", "#16a34a", "#d97706", "#dc2626", "#9333ea", "#0d9488", "#64748b"];

interface FormState {
  id?: number;
  name: string;
  institution: string;
  type: (typeof TYPES)[number];
  currency: string;
  last4: string;
  opening_balance: string; // dollars, string form
  opening_balance_date: string;
  color: string;
}

const EMPTY: FormState = {
  name: "",
  institution: "",
  type: "chequing",
  currency: "CAD",
  last4: "",
  opening_balance: "0",
  opening_balance_date: "",
  color: COLORS[0]!,
};

export default function Accounts() {
  const [accounts, setAccounts] = useState<AccountWithBalance[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setError] = useState("");

  const load = () => api.get<AccountWithBalance[]>("/accounts").then(setAccounts).catch(console.error);
  useEffect(() => {
    load();
  }, []);

  const save = async () => {
    if (!form) return;
    setError("");
    const body = {
      name: form.name,
      institution: form.institution || null,
      type: form.type,
      currency: form.currency.toUpperCase(),
      last4: form.last4 || null,
      opening_balance_cents: Math.round(parseFloat(form.opening_balance || "0") * 100),
      opening_balance_date: form.opening_balance_date || null,
      color: form.color,
    };
    try {
      if (form.id) await api.patch(`/accounts/${form.id}`, body);
      else await api.post("/accounts", body);
      setForm(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const archive = async (a: AccountWithBalance) => {
    if (!confirm(`Archive "${a.name}"? Its transactions are kept but it disappears from dashboards.`)) return;
    await api.patch(`/accounts/${a.id}`, { archived: 1 });
    load();
  };

  return (
    <>
      <div className="page-head">
        <h1>Accounts</h1>
        <button className="primary" onClick={() => setForm({ ...EMPTY })}>
          <Plus size={14} style={{ verticalAlign: -2 }} /> Add account
        </button>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
        {accounts.map((a) => (
          <div className="card" key={a.id} style={{ borderTop: `3px solid ${a.color}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
              <div>
                <h3>{a.name}</h3>
                <div className="faint">
                  {a.institution ?? "—"} · {a.type}
                  {a.last4 ? ` · ••${a.last4}` : ""}
                </div>
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                <button
                  style={{ padding: "4px 8px" }}
                  onClick={() =>
                    setForm({
                      id: a.id,
                      name: a.name,
                      institution: a.institution ?? "",
                      type: a.type,
                      currency: a.currency,
                      last4: a.last4 ?? "",
                      opening_balance: (a.opening_balance_cents / 100).toFixed(2),
                      opening_balance_date: a.opening_balance_date ?? "",
                      color: a.color,
                    })
                  }
                >
                  <Pencil size={13} />
                </button>
                <button style={{ padding: "4px 8px" }} onClick={() => archive(a)}>
                  <Archive size={13} />
                </button>
              </div>
            </div>
            <div className={`money ${a.balance_cents < 0 ? "neg" : ""}`} style={{ fontSize: 22, fontWeight: 700, marginTop: 10 }}>
              {fmtMoney(a.balance_cents, a.currency)}
            </div>
            <div className="faint">
              {a.currency !== "CAD" ? `≈ ${fmtMoney(a.balance_cad_cents)} CAD · ` : ""}
              {a.txn_count} transactions
              {a.kind === "liability" ? " · liability" : ""}
            </div>
          </div>
        ))}
        {accounts.length === 0 && <div className="empty-state card">No accounts yet. Add your chequing, credit and prepaid cards.</div>}
      </div>

      {form && (
        <div className="modal-backdrop" onClick={() => setForm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 16 }}>{form.id ? "Edit account" : "Add account"}</h2>
            {error && <div className="alert error">{error}</div>}
            <div className="form-row">
              <label>Name</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="RBC Chequing" />
            </div>
            <div className="form-grid-2">
              <div className="form-row">
                <label>Institution</label>
                <input value={form.institution} onChange={(e) => setForm({ ...form, institution: e.target.value })} placeholder="RBC" />
              </div>
              <div className="form-row">
                <label>Type</label>
                <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as FormState["type"] })}>
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <label>Currency</label>
                <input value={form.currency} maxLength={3} onChange={(e) => setForm({ ...form, currency: e.target.value })} />
              </div>
              <div className="form-row">
                <label>Last 4 digits</label>
                <input value={form.last4} maxLength={4} onChange={(e) => setForm({ ...form, last4: e.target.value })} />
              </div>
              <div className="form-row">
                <label>Opening balance</label>
                <input value={form.opening_balance} onChange={(e) => setForm({ ...form, opening_balance: e.target.value })} />
              </div>
              <div className="form-row">
                <label>As of date</label>
                <input type="date" value={form.opening_balance_date} onChange={(e) => setForm({ ...form, opening_balance_date: e.target.value })} />
              </div>
            </div>
            {form.type === "credit" && (
              <div className="alert info">Credit cards are liabilities — enter the amount you owe as a negative opening balance (e.g. -500).</div>
            )}
            <div className="form-row">
              <label>Color</label>
              <div style={{ display: "flex", gap: 6 }}>
                {COLORS.map((c) => (
                  <span
                    key={c}
                    onClick={() => setForm({ ...form, color: c })}
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 6,
                      background: c,
                      cursor: "pointer",
                      outline: form.color === c ? "2px solid var(--text)" : "none",
                      outlineOffset: 2,
                    }}
                  />
                ))}
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button onClick={() => setForm(null)}>Cancel</button>
              <button className="primary" onClick={save} disabled={!form.name}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
