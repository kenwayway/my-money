import { useEffect, useState } from "react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend } from "recharts";
import { AlertCircle, TrendingDown, TrendingUp } from "lucide-react";
import { api, fmtMoney, type NetWorthSummary, type SpendingSummary } from "../api";

export default function Dashboard({ onNavigate }: { onNavigate: (page: string) => void }) {
  const [netWorth, setNetWorth] = useState<NetWorthSummary | null>(null);
  const [spending, setSpending] = useState<SpendingSummary | null>(null);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));

  useEffect(() => {
    api.get<NetWorthSummary>("/summary/net-worth").then(setNetWorth).catch(console.error);
  }, []);
  useEffect(() => {
    api.get<SpendingSummary>(`/summary/spending?month=${month}`).then(setSpending).catch(console.error);
  }, [month]);

  if (!netWorth) return <div className="empty-state">Loading…</div>;

  const donutData = (spending?.by_category ?? []).map((c) => ({
    name: c.category_name,
    value: c.total_cad_cents / 100,
    color: c.category_color,
  }));
  const monthTotal = (spending?.by_category ?? []).reduce((s, c) => s + c.total_cad_cents, 0);
  const trendData = (spending?.trend ?? []).map((t) => ({
    month: t.month.slice(5),
    Spending: t.expense_cad_cents / 100,
    Income: t.income_cad_cents / 100,
  }));

  return (
    <>
      <div className="page-head">
        <h1>Dashboard</h1>
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
      </div>

      {spending && spending.uncategorized_count > 0 && (
        <div className="alert warn" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <AlertCircle size={15} />
          {spending.uncategorized_count} uncategorized transaction{spending.uncategorized_count > 1 ? "s" : ""} —{" "}
          <a style={{ cursor: "pointer", textDecoration: "underline" }} onClick={() => onNavigate("transactions")}>
            review
          </a>
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr", marginBottom: 14 }}>
        <div className="card">
          <div className="faint">NET WORTH (CAD)</div>
          <div className="money" style={{ fontSize: 26, fontWeight: 700, marginTop: 4 }}>
            {fmtMoney(netWorth.total_cad_cents)}
          </div>
        </div>
        <div className="card">
          <div className="faint" style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <TrendingUp size={13} /> ASSETS
          </div>
          <div className="money pos" style={{ fontSize: 26, fontWeight: 700, marginTop: 4 }}>
            {fmtMoney(netWorth.assets_cad_cents)}
          </div>
        </div>
        <div className="card">
          <div className="faint" style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <TrendingDown size={13} /> LIABILITIES
          </div>
          <div className="money neg" style={{ fontSize: 26, fontWeight: 700, marginTop: 4 }}>
            {fmtMoney(netWorth.liabilities_cad_cents)}
          </div>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "5fr 7fr", marginBottom: 14 }}>
        <div className="card">
          <h2>Spending by category — {month}</h2>
          {donutData.length === 0 ? (
            <div className="empty-state">No spending this month</div>
          ) : (
            <>
              <div style={{ height: 220 }}>
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={donutData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={2}>
                      {donutData.map((d, i) => (
                        <Cell key={i} fill={d.color} stroke="none" />
                      ))}
                    </Pie>
                    <Tooltip formatter={(v) => `$${Number(v).toLocaleString("en-CA", { minimumFractionDigits: 2 })}`} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                {(spending?.by_category ?? []).slice(0, 8).map((c) => (
                  <div key={String(c.category_id)} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: c.category_color, flexShrink: 0 }} />
                    <span style={{ flex: 1 }}>{c.category_name}</span>
                    <span className="faint">{monthTotal > 0 ? Math.round((c.total_cad_cents / monthTotal) * 100) : 0}%</span>
                    <span className="money">{fmtMoney(c.total_cad_cents)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="card">
          <h2>6-month trend (CAD)</h2>
          <div style={{ height: 300, marginTop: 12 }}>
            <ResponsiveContainer>
              <BarChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="month" tick={{ fill: "var(--text-dim)", fontSize: 12 }} />
                <YAxis tick={{ fill: "var(--text-dim)", fontSize: 12 }} />
                <Tooltip formatter={(v) => `$${Number(v).toLocaleString("en-CA", { minimumFractionDigits: 2 })}`} />
                <Legend />
                <Bar dataKey="Income" fill="var(--green)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Spending" fill="var(--red)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Accounts</h2>
        <table className="table" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>Account</th>
              <th>Type</th>
              <th>Currency</th>
              <th style={{ textAlign: "right" }}>Balance</th>
              <th style={{ textAlign: "right" }}>CAD</th>
            </tr>
          </thead>
          <tbody>
            {netWorth.accounts.map((a) => (
              <tr key={a.id}>
                <td>
                  <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 3, background: a.color, marginRight: 8 }} />
                  {a.name}
                  {a.last4 && <span className="faint"> ••{a.last4}</span>}
                </td>
                <td>
                  <span className="badge">{a.type}</span>
                </td>
                <td>{a.currency}</td>
                <td className={`money ${a.balance_cents < 0 ? "neg" : ""}`} style={{ textAlign: "right" }}>
                  {fmtMoney(a.balance_cents, a.currency)}
                </td>
                <td className={`money ${a.balance_cad_cents < 0 ? "neg" : ""}`} style={{ textAlign: "right" }}>
                  {fmtMoney(a.balance_cad_cents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {netWorth.accounts.length === 0 && (
          <div className="empty-state">
            No accounts yet — <a style={{ cursor: "pointer", textDecoration: "underline" }} onClick={() => onNavigate("accounts")}>add your first account</a>
          </div>
        )}
      </div>
    </>
  );
}
