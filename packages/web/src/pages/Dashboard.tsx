import { useEffect, useState } from "react";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Treemap,
} from "recharts";
import { X } from "lucide-react";
import {
  api,
  fmtMoney,
  type FinancialInboxSummary,
  type NetWorthSummary,
  type SpendingSummary,
  type TxnRow,
} from "../api";
import { catEmoji } from "../categoryIcons";
import MonthPicker from "../components/MonthPicker";
import FinancialInbox from "../components/FinancialInbox";

interface TipEntry {
  dataKey?: string | number;
  name?: string | number;
  value?: number | string;
  color?: string;
  fill?: string;
  stroke?: string;
  payload?: { color?: string; fill?: string };
}

function ChartTip({ active, payload, label }: { active?: boolean; payload?: TipEntry[]; label?: string | number }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tip">
      {label != null && <div className="chart-tip-title">{label}</div>}
      {payload.map((p) => (
        <div className="chart-tip-row" key={String(p.dataKey ?? p.name)}>
          <i style={{ background: p.stroke ?? p.fill ?? p.color ?? p.payload?.color ?? p.payload?.fill }} />
          <span className="dim">{p.name}</span>
          <span className="money">${Number(p.value).toLocaleString("en-CA", { minimumFractionDigits: 2 })}</span>
        </div>
      ))}
    </div>
  );
}

/** black or white text depending on the fill's luminance */
function textColorOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? "#1f2937" : "#ffffff";
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

type CatSpend = SpendingSummary["by_category"][number];
type TransferSuggestion = FinancialInboxSummary["transfer_suggestions"][number];
type TrendMode = "total" | "category";

interface CategoryTrendLine {
  key: string;
  name: string;
  color: string;
  total_cad_cents: number;
}

function categoryTrendKey(categoryId: number | null): string {
  return categoryId === null ? "category_uncategorized" : `category_${categoryId}`;
}

export default function Dashboard({ onNavigate }: { onNavigate: (page: string) => void }) {
  const [netWorth, setNetWorth] = useState<NetWorthSummary | null>(null);
  const [spending, setSpending] = useState<SpendingSummary | null>(null);
  const [inbox, setInbox] = useState<FinancialInboxSummary | null>(null);
  const [inboxError, setInboxError] = useState("");
  const [pairingId, setPairingId] = useState<number | null>(null);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [drill, setDrill] = useState<CatSpend | null>(null);
  const [drillRows, setDrillRows] = useState<TxnRow[] | null>(null);
  const [chartMode, setChartMode] = useState<"donut" | "treemap">(() =>
    localStorage.getItem("spend-chart") === "treemap" ? "treemap" : "donut"
  );
  const [trendMode, setTrendModeState] = useState<TrendMode>(() =>
    localStorage.getItem("trend-chart") === "category" ? "category" : "total"
  );
  const [hiddenTrendKeys, setHiddenTrendKeys] = useState<Set<string>>(() => new Set());

  const setMode = (m: "donut" | "treemap") => {
    setChartMode(m);
    localStorage.setItem("spend-chart", m);
  };
  const setTrendMode = (m: TrendMode) => {
    setTrendModeState(m);
    localStorage.setItem("trend-chart", m);
  };
  const toggleTrendLine = (key: string) => {
    if (drill && key === categoryTrendKey(drill.category_id)) return;
    setHiddenTrendKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  useEffect(() => {
    api.get<NetWorthSummary>("/summary/net-worth").then(setNetWorth).catch(console.error);
    api.get<FinancialInboxSummary>("/summary/inbox").then(setInbox).catch((e) => {
      setInboxError(`Could not load financial inbox: ${e instanceof Error ? e.message : e}`);
    });
  }, []);
  useEffect(() => {
    api.get<SpendingSummary>(`/summary/spending?month=${month}`).then(setSpending).catch(console.error);
  }, [month]);

  // load the flat transaction list for the clicked slice
  useEffect(() => {
    if (!drill) {
      setDrillRows(null);
      return;
    }
    const p = new URLSearchParams();
    if (drill.category_id === null) p.set("uncategorized", "1");
    else p.set("category_id", String(drill.category_id));
    p.set("from", `${month}-01`);
    p.set("to", `${month}-31`);
    p.set("limit", "500");
    api
      .get<{ rows: TxnRow[] }>(`/transactions?${p}`)
      .then((r) =>
        setDrillRows(
          r.rows.filter((t) => !t.is_transfer && !(t.amount_cents > 0 && t.refund_peer_id !== null))
        )
      ) // match the donut's scope
      .catch(console.error);
  }, [drill, month]);

  const changeMonth = (m: string) => {
    setMonth(m);
    setDrill(null);
    setHiddenTrendKeys(new Set());
  };

  const toggleDrill = (c: CatSpend) => {
    if (drill?.category_id === c.category_id) {
      setDrill(null);
      return;
    }
    setDrill(c);
    setTrendMode("category");
    const selectedKey = categoryTrendKey(c.category_id);
    setHiddenTrendKeys((current) => {
      if (!current.has(selectedKey)) return current;
      const next = new Set(current);
      next.delete(selectedKey);
      return next;
    });
  };

  const openInTransactions = () => {
    if (!drill) return;
    sessionStorage.setItem(
      "txn-prefill",
      JSON.stringify({ category_id: drill.category_id === null ? "uncat" : String(drill.category_id), month })
    );
    onNavigate("transactions");
  };

  const reviewUncategorized = () => {
    sessionStorage.setItem("txn-prefill", JSON.stringify({ category_id: "uncat" }));
    onNavigate("transactions");
  };

  const pairSuggestedTransfer = async (suggestion: TransferSuggestion) => {
    if (
      !confirm(
        `Link ${suggestion.a.account_name} ${fmtMoney(suggestion.a.amount_cents, suggestion.a.currency, true)} ` +
          `and ${suggestion.b.account_name} ${fmtMoney(suggestion.b.amount_cents, suggestion.b.currency, true)} as one transfer?`
      )
    ) {
      return;
    }
    setPairingId(suggestion.a.id);
    setInboxError("");
    try {
      await api.post("/transactions/pair-transfer", {
        id_a: suggestion.a.id,
        id_b: suggestion.b.id,
      });
      const [nextInbox, nextSpending] = await Promise.all([
        api.get<FinancialInboxSummary>("/summary/inbox"),
        api.get<SpendingSummary>(`/summary/spending?month=${month}`),
      ]);
      setInbox(nextInbox);
      setSpending(nextSpending);
    } catch (e) {
      setInboxError(`Could not link transfer: ${e instanceof Error ? e.message : e}`);
    } finally {
      setPairingId(null);
    }
  };

  if (!netWorth) return <div className="empty-state">Loading…</div>;

  const donutData = (spending?.by_category ?? []).map((c) => ({
    name: c.category_name,
    value: c.total_cad_cents / 100,
    color: c.category_color,
    emoji: catEmoji(c.category_icon),
    category_id: c.category_id,
  }));
  const monthTotal = (spending?.by_category ?? []).reduce((s, c) => s + c.total_cad_cents, 0);
  const trendData = (spending?.trend ?? []).map((t) => ({
    month: new Date(`${t.month}-01T00:00:00`).toLocaleString("en", { month: "short" }),
    Spending: t.expense_cad_cents / 100,
    Income: t.income_cad_cents / 100,
  }));
  const categoryTrendTotals = new Map<string, CategoryTrendLine>();
  for (const entry of spending?.category_trend ?? []) {
    const key = categoryTrendKey(entry.category_id);
    const existing = categoryTrendTotals.get(key);
    if (existing) {
      existing.total_cad_cents += entry.total_cad_cents;
    } else {
      categoryTrendTotals.set(key, {
        key,
        name: entry.category_name,
        color: entry.category_color,
        total_cad_cents: entry.total_cad_cents,
      });
    }
  }
  const allTrendCategories = [...categoryTrendTotals.values()].sort(
    (a, b) => b.total_cad_cents - a.total_cad_cents
  );
  const selectedTrendKey = drill ? categoryTrendKey(drill.category_id) : null;
  const selectedTrendCategory = selectedTrendKey ? categoryTrendTotals.get(selectedTrendKey) : undefined;
  const defaultTopTrendCategories = allTrendCategories.slice(0, 5);
  const topTrendCategories =
    selectedTrendCategory && !defaultTopTrendCategories.some((category) => category.key === selectedTrendKey)
      ? [...defaultTopTrendCategories.slice(0, 4), selectedTrendCategory]
      : defaultTopTrendCategories;
  const topTrendKeys = new Set(topTrendCategories.map((category) => category.key));
  const otherTrendCategories = allTrendCategories.filter((category) => !topTrendKeys.has(category.key));
  const trendLines: CategoryTrendLine[] = [
    ...topTrendCategories,
    ...(otherTrendCategories.length > 0
      ? [
          {
            key: "category_other",
            name: "Other",
            color: "var(--text-faint)",
            total_cad_cents: otherTrendCategories.reduce((sum, category) => sum + category.total_cad_cents, 0),
          },
        ]
      : []),
  ];
  const categoryTrendData = (spending?.trend ?? []).map((monthEntry) => {
    const row: Record<string, string | number> = {
      month: new Date(`${monthEntry.month}-01T00:00:00`).toLocaleString("en", { month: "short" }),
    };
    for (const line of trendLines) row[line.key] = 0;
    for (const entry of spending?.category_trend ?? []) {
      if (entry.month !== monthEntry.month) continue;
      const key = categoryTrendKey(entry.category_id);
      const dataKey = topTrendKeys.has(key) ? key : "category_other";
      row[dataKey] = Number(row[dataKey] ?? 0) + entry.total_cad_cents / 100;
    }
    return row;
  });

  return (
    <>
      <div className="page-head">
        <h1>Dashboard</h1>
        <MonthPicker value={month} onChange={changeMonth} />
      </div>

      <FinancialInbox
        inbox={inbox}
        pairingId={pairingId}
        error={inboxError}
        onNavigate={onNavigate}
        onReviewUncategorized={reviewUncategorized}
        onPairTransfer={pairSuggestedTransfer}
      />

      <div className="grid grid-top" style={{ gridTemplateColumns: "5fr 7fr", marginBottom: 14 }}>
        <div className="card">
          <div className="chart-head">
            <h2>Spending by category — {month}</h2>
            <div style={{ display: "flex", gap: 4 }}>
              <button className={chartMode === "donut" ? "primary" : ""} style={{ padding: "3px 9px", fontSize: 12 }} onClick={() => setMode("donut")}>
                Donut
              </button>
              <button className={chartMode === "treemap" ? "primary" : ""} style={{ padding: "3px 9px", fontSize: 12 }} onClick={() => setMode("treemap")}>
                Treemap
              </button>
            </div>
          </div>
          {donutData.length === 0 ? (
            <div className="empty-state">No spending this month</div>
          ) : (
            <>
              <div style={{ height: 230, position: "relative", marginTop: 8 }}>
                {chartMode === "donut" ? (
                  <>
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
                          style={{ cursor: "pointer", outline: "none" }}
                          onClick={(_, index) => {
                            const c = spending?.by_category[index];
                            if (c) toggleDrill(c);
                          }}
                        >
                          {donutData.map((d, i) => (
                            <Cell
                              key={i}
                              fill={d.color}
                              stroke="none"
                              fillOpacity={drill && drill.category_id !== d.category_id ? 0.3 : 1}
                            />
                          ))}
                        </Pie>
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="donut-center">
                      <div className="faint">Total</div>
                      <div className="money">{fmtMoney(monthTotal)}</div>
                    </div>
                  </>
                ) : (
                  <ResponsiveContainer>
                    <Treemap
                      data={donutData}
                      dataKey="value"
                      nameKey="name"
                      aspectRatio={4 / 3}
                      isAnimationActive={false}
                      content={((p: { x?: number; y?: number; width?: number; height?: number; name?: string }) => {
                        const d = donutData.find((c) => c.name === p.name);
                        const { x = 0, y = 0, width = 0, height = 0 } = p;
                        if (!d || width <= 0 || height <= 0) return <g />;
                        const dim = drill && drill.category_id !== d.category_id;
                        const fg = textColorOn(d.color ?? "#888888");
                        const cents = Math.round(d.value * 100);
                        const pct = monthTotal > 0 ? Math.round((cents / monthTotal) * 100) : 0;
                        return (
                          <g
                            style={{ cursor: "pointer" }}
                            onClick={() => {
                              const c = spending?.by_category.find((x2) => x2.category_name === d.name);
                              if (c) toggleDrill(c);
                            }}
                          >
                            <title>{`${d.name} — ${fmtMoney(cents)} (${pct}%)`}</title>
                            <rect x={x} y={y} width={width} height={height} rx={4} fill={d.color ?? "#888888"} fillOpacity={dim ? 0.25 : 0.92} stroke="var(--bg)" strokeWidth={2} />
                            {/* labels live in a foreignObject so CSS ellipsis keeps them inside the tile —
                                a bare <text> overflows and the next tile's rect paints over it */}
                            {width > 46 && height > 24 && (
                              <foreignObject x={x + 6} y={y + 4} width={width - 12} height={height - 8} style={{ pointerEvents: "none" }}>
                                <div className="tm-label" style={{ color: fg, opacity: dim ? 0.5 : 1 }}>
                                  <div className="tm-label-name">
                                    {d.emoji} {d.name}
                                  </div>
                                  {/* an ellipsised "$240…" says nothing — drop the line unless it fits */}
                                  {width > 78 && height > 42 && (
                                    <div className="tm-label-amt">
                                      {fmtMoney(cents)} · {pct}%
                                    </div>
                                  )}
                                </div>
                              </foreignObject>
                            )}
                          </g>
                        );
                        // recharts' content prop typing wants an element; a render fn works at runtime
                      }) as unknown as React.ReactElement}
                    />
                  </ResponsiveContainer>
                )}
              </div>
              <div className="cat-bars">
                {(() => {
                  const cats = (spending?.by_category ?? []).slice(0, 8);
                  const max = Math.max(1, ...cats.map((c) => c.total_cad_cents));
                  return cats.map((c) => (
                    <div
                      key={String(c.category_id)}
                      className="cat-bar-row"
                      style={{ cursor: "pointer", opacity: drill && drill.category_id !== c.category_id ? 0.45 : 1 }}
                      onClick={() => toggleDrill(c)}
                      title={`Show ${c.category_name} transactions`}
                    >
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
            <div style={{ display: "flex", gap: 4 }}>
              <button
                className={trendMode === "total" ? "primary" : ""}
                style={{ padding: "3px 9px", fontSize: 12 }}
                onClick={() => setTrendMode("total")}
              >
                Total
              </button>
              <button
                className={trendMode === "category" ? "primary" : ""}
                style={{ padding: "3px 9px", fontSize: 12 }}
                onClick={() => setTrendMode("category")}
              >
                By category
              </button>
            </div>
          </div>
          {trendMode === "total" ? (
            <div className="chart-legend trend-chart-legend">
              <span>
                <i style={{ background: "var(--chart-income)" }} /> Income
              </span>
              <span>
                <i style={{ background: "var(--chart-expense)" }} /> Spending
              </span>
            </div>
          ) : (
            <div className="trend-category-legend" aria-label="Category trend legend">
              {trendLines.map((line) => {
                const hidden = hiddenTrendKeys.has(line.key);
                const selected = line.key === selectedTrendKey;
                return (
                  <button
                    type="button"
                    key={line.key}
                    className={[hidden ? "is-hidden" : "", selected ? "is-selected" : ""].filter(Boolean).join(" ")}
                    onClick={() => toggleTrendLine(line.key)}
                    title={selected ? `${line.name} is selected` : `${hidden ? "Show" : "Hide"} ${line.name}`}
                  >
                    <i style={{ background: line.color }} />
                    {line.name}
                  </button>
                );
              })}
            </div>
          )}
          {trendMode === "category" && trendLines.length === 0 ? (
            <div className="empty-state">No category spending in this period</div>
          ) : (
            <div style={{ height: 340, marginTop: 14 }}>
              <ResponsiveContainer>
                {trendMode === "total" ? (
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
                ) : (
                  <LineChart data={categoryTrendData} margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
                    <CartesianGrid vertical={false} stroke="var(--border)" />
                    <XAxis dataKey="month" tick={{ fill: "var(--text-faint)", fontSize: 11.5 }} tickLine={false} axisLine={{ stroke: "var(--border-strong)" }} tickMargin={8} />
                    <YAxis
                      tick={{ fill: "var(--text-faint)", fontSize: 11.5, fontFamily: "var(--font-mono)" }}
                      tickLine={false}
                      axisLine={false}
                      width={44}
                      tickFormatter={(v: number) => (v >= 1000 ? `$${v % 1000 === 0 ? v / 1000 : (v / 1000).toFixed(1)}k` : `$${v}`)}
                    />
                    <Tooltip cursor={{ stroke: "var(--border-strong)" }} content={<ChartTip />} />
                    {trendLines
                      .filter((line) => !hiddenTrendKeys.has(line.key))
                      .sort(
                        (a, b) =>
                          Number(a.key === selectedTrendKey) - Number(b.key === selectedTrendKey)
                      )
                      .map((line) => (
                        <Line
                          key={line.key}
                          type="monotone"
                          dataKey={line.key}
                          name={line.name}
                          stroke={line.color}
                          strokeWidth={line.key === selectedTrendKey ? 3.5 : 2}
                          strokeOpacity={selectedTrendKey && line.key !== selectedTrendKey ? 0.18 : 1}
                          dot={false}
                          activeDot={
                            selectedTrendKey && line.key !== selectedTrendKey
                              ? false
                              : { r: line.key === selectedTrendKey ? 5 : 4, strokeWidth: 0 }
                          }
                          isAnimationActive={false}
                        />
                      ))}
                  </LineChart>
                )}
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      {drill && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span className="cat-emoji" style={{ background: `${drill.category_color}1f` }}>{catEmoji(drill.category_icon)}</span>
            <h2 style={{ margin: 0 }}>
              {drill.category_name} — {month}
            </h2>
            <span className="money">{fmtMoney(drill.total_cad_cents)}</span>
            <span className="faint">{drillRows ? `${drillRows.length} transaction${drillRows.length === 1 ? "" : "s"}` : "loading…"}</span>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
              <a style={{ cursor: "pointer", textDecoration: "underline" }} onClick={openInTransactions}>
                Open in Transactions
              </a>
              <button title="Close" style={{ padding: "3px 7px" }} onClick={() => setDrill(null)}>
                <X size={13} />
              </button>
            </div>
          </div>
          <table className="table" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Description</th>
                <th>Account</th>
                <th style={{ textAlign: "right" }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {(drillRows ?? []).map((t) => (
                <tr key={t.id}>
                  <td className="dim" style={{ whiteSpace: "nowrap" }}>{t.posted_date}</td>
                  <td style={{ maxWidth: 460 }}>
                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.description_raw}>
                      {t.description_raw}
                    </div>
                    {t.notes && (
                      <div className="faint" style={{ fontSize: 12, fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.notes}>
                        {t.notes}
                      </div>
                    )}
                  </td>
                  <td className="dim">{t.account_name}</td>
                  <td className={`money ${t.amount_cents < 0 ? "" : "pos"}`} style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {fmtMoney(
                      t.refund_peer_amount_cents !== null ? t.amount_cents + t.refund_peer_amount_cents : t.amount_cents,
                      t.account_currency,
                      true
                    )}
                    {t.refund_peer_amount_cents !== null && (
                      <div className="faint" style={{ fontSize: 11 }}>
                        after {fmtMoney(t.refund_peer_amount_cents, t.account_currency)} refund
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {drillRows && drillRows.length === 0 && <div className="empty-state">No transactions in this category this month.</div>}
        </div>
      )}

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
                <td className={`money ${a.balance_cad_cents !== null && a.balance_cad_cents < 0 ? "neg" : ""}`} style={{ textAlign: "right" }}>
                  {a.balance_cad_cents === null ? "FX required" : fmtMoney(a.balance_cad_cents)}
                </td>
              </tr>
            ))}
          </tbody>
          {netWorth.accounts.length > 0 && (
            <tfoot>
              <tr className="total-row">
                <td colSpan={4}>
                  {netWorth.fx_complete && netWorth.assets_cad_cents !== null && netWorth.liabilities_cad_cents !== null
                    ? `Net worth · assets ${fmtMoney(netWorth.assets_cad_cents)} · liabilities ${fmtMoney(netWorth.liabilities_cad_cents)}`
                    : "Net worth unavailable · missing FX rates"}
                </td>
                <td className="money" style={{ textAlign: "right" }}>
                  {netWorth.total_cad_cents === null ? "—" : fmtMoney(netWorth.total_cad_cents)}
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
