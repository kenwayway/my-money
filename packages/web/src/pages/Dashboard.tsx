import { useEffect, useState } from "react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts";
import { AlertCircle } from "lucide-react";
import { api, fmtMoney, type NetWorthSummary, type SpendingSummary } from "../api";
import { catEmoji } from "../categoryIcons";
import MonthPicker from "../components/MonthPicker";

interface TipEntry {
  dataKey?: string | number;
  name?: string | number;
  value?: number | string;
  color?: string;
  fill?: string;
  payload?: { color?: string; fill?: string };
}

function ChartTip({ active, payload, label }: { active?: boolean; payload?: TipEntry[]; label?: string | number }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tip">
      {label != null && <div className="chart-tip-title">{label}</div>}
      {payload.map((p) => (
        <div className="chart-tip-row" key={String(p.dataKey ?? p.name)}>
          <i style={{ background: p.fill ?? p.color ?? p.payload?.color ?? p.payload?.fill }} />
          <span className="dim">{p.name}</span>
          <span className="money">${Number(p.value).toLocaleString("en-CA", { minimumFractionDigits: 2 })}</span>
        </div>
      ))}
    </div>
  );
}

const RAD = Math.PI / 180;
interface DonutLabelProps {
  cx?: number;
  cy?: number;
  midAngle?: number;
  outerRadius?: number;
  percent?: number;
  name?: string;
  emoji?: string;
}

// always-visible labels for slices big enough to carry one; the rest live in the bar list below
function donutLabel({ cx = 0, cy = 0, midAngle = 0, outerRadius = 0, percent = 0, name, emoji }: DonutLabelProps) {
  if (percent < 0.05) return null;
  const cos = Math.cos(-midAngle * RAD);
  const sin = Math.sin(-midAngle * RAD);
  const sx = cx + (outerRadius + 2) * cos;
  const sy = cy + (outerRadius + 2) * sin;
  const mx = cx + (outerRadius + 12) * cos;
  const my = cy + (outerRadius + 12) * sin;
  const ex = mx + (cos >= 0 ? 8 : -8);
  return (
    <g>
      <path d={`M${sx},${sy}L${mx},${my}L${ex},${my}`} stroke="var(--border-strong)" strokeWidth={1} fill="none" />
      <text x={ex + (cos >= 0 ? 4 : -4)} y={my} textAnchor={cos >= 0 ? "start" : "end"} dominantBaseline="central" fill="var(--text-dim)" fontSize={11.5}>
        {emoji ? `${emoji} ` : ""}{name} {Math.round(percent * 100)}%
      </text>
    </g>
  );
}

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
    emoji: catEmoji(c.category_icon),
  }));
  const monthTotal = (spending?.by_category ?? []).reduce((s, c) => s + c.total_cad_cents, 0);
  const trendData = (spending?.trend ?? []).map((t) => ({
    month: new Date(`${t.month}-01T00:00:00`).toLocaleString("en", { month: "short" }),
    Spending: t.expense_cad_cents / 100,
    Income: t.income_cad_cents / 100,
  }));

  return (
    <>
      <div className="page-head">
        <h1>Dashboard</h1>
        <MonthPicker value={month} onChange={setMonth} />
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

      <div className="grid" style={{ gridTemplateColumns: "5fr 7fr", marginBottom: 14 }}>
        <div className="card">
          <h2>Spending by category — {month}</h2>
          {donutData.length === 0 ? (
            <div className="empty-state">No spending this month</div>
          ) : (
            <>
              <div style={{ height: 230, position: "relative" }}>
                <ResponsiveContainer>
                  <PieChart>
                    <Pie
                      data={donutData}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={54}
                      outerRadius={78}
                      paddingAngle={2}
                      label={donutLabel}
                      labelLine={false}
                      isAnimationActive={false}
                    >
                      {donutData.map((d, i) => (
                        <Cell key={i} fill={d.color} stroke="none" />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div className="donut-center">
                  <div className="faint">Total</div>
                  <div className="money">{fmtMoney(monthTotal)}</div>
                </div>
              </div>
              <div className="cat-bars">
                {(() => {
                  const cats = (spending?.by_category ?? []).slice(0, 8);
                  const max = Math.max(1, ...cats.map((c) => c.total_cad_cents));
                  return cats.map((c) => (
                    <div key={String(c.category_id)} className="cat-bar-row">
                      <span className="cat-bar-name" title={c.category_name}>
                        <span className="cat-emoji" style={{ background: `${c.category_color}1f` }}>{catEmoji(c.category_icon)}</span>
                        {c.category_name}
                      </span>
                      <span className="cat-bar-track">
                        <span
                          className="cat-bar-fill"
                          style={{ width: `${(c.total_cad_cents / max) * 100}%`, background: c.category_color }}
                        />
                      </span>
                      <span className="faint cat-bar-pct">{monthTotal > 0 ? Math.round((c.total_cad_cents / monthTotal) * 100) : 0}%</span>
                      <span className="money cat-bar-amount">{fmtMoney(c.total_cad_cents)}</span>
                    </div>
                  ));
                })()}
              </div>
            </>
          )}
        </div>
        <div className="card">
          <div className="chart-head">
            <h2>6-month trend (CAD)</h2>
            <div className="chart-legend">
              <span>
                <i style={{ background: "var(--chart-income)" }} /> Income
              </span>
              <span>
                <i style={{ background: "var(--chart-expense)" }} /> Spending
              </span>
            </div>
          </div>
          <div style={{ height: 300, marginTop: 14 }}>
            <ResponsiveContainer>
              <BarChart data={trendData} barGap={2} barCategoryGap="28%" margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis dataKey="month" tick={{ fill: "var(--text-faint)", fontSize: 11.5 }} tickLine={false} axisLine={{ stroke: "var(--border-strong)" }} tickMargin={8} />
                <YAxis
                  tick={{ fill: "var(--text-faint)", fontSize: 11.5, fontFamily: "var(--font-mono)" }}
                  tickLine={false}
                  axisLine={false}
                  width={44}
                  tickFormatter={(v: number) => (v >= 1000 ? `$${v % 1000 === 0 ? v / 1000 : (v / 1000).toFixed(1)}k` : `$${v}`)}
                />
                <Tooltip cursor={{ fill: "var(--bg-hover)", opacity: 0.6 }} content={<ChartTip />} />
                <Bar dataKey="Income" fill="var(--chart-income)" radius={[4, 4, 0, 0]} maxBarSize={18} />
                <Bar dataKey="Spending" fill="var(--chart-expense)" radius={[4, 4, 0, 0]} maxBarSize={18} />
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
          {netWorth.accounts.length > 0 && (
            <tfoot>
              <tr className="total-row">
                <td colSpan={4}>
                  Net worth · assets {fmtMoney(netWorth.assets_cad_cents)} · liabilities {fmtMoney(netWorth.liabilities_cad_cents)}
                </td>
                <td className="money" style={{ textAlign: "right" }}>
                  {fmtMoney(netWorth.total_cad_cents)}
                </td>
              </tr>
            </tfoot>
          )}
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
