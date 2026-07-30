import { useEffect, useState } from "react";
import { Trash2, Plus, Download } from "lucide-react";
import { api, fmtMoney, type Category, type CategoryType } from "../api";
import { catEmoji } from "../categoryIcons";

interface RuleRow {
  id: number;
  pattern: string;
  match_type: string;
  category_name: string;
  category_color: string;
  source: "ai" | "user";
}

interface FxRow {
  currency: string;
  rate_to_cad: number;
}

export default function Settings() {
  const [settings, setSettings] = useState<Record<string, string | boolean>>({});
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [fx, setFx] = useState<FxRow[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [newFx, setNewFx] = useState({ currency: "", rate: "" });
  const [newCat, setNewCat] = useState({ name: "", type: "expense" as CategoryType });

  const load = () => {
    api.get<Record<string, string | boolean>>("/settings").then(setSettings).catch(console.error);
    api.get<RuleRow[]>("/merchant-rules").then(setRules).catch(console.error);
    api.get<FxRow[]>("/fx-rates").then(setFx).catch(console.error);
    api.get<Category[]>("/categories").then(setCategories).catch(console.error);
  };
  useEffect(load, []);

  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", alignItems: "start" }}>
        <div className="card" style={{ gridColumn: "1 / -1" }}>
          <h2>Backup</h2>
          <p className="dim">
            Download a consistent ZIP containing the database, every stored PDF/CSV statement, and restore instructions. This remains safe while the app and MCP server are running.
          </p>
          <button className="primary" onClick={() => { window.location.href = "/api/settings/backup"; }}>
            <Download size={14} style={{ verticalAlign: -2 }} /> Download full backup
          </button>
        </div>

        <div className="card">
          <h2>MCP server（AI 助手接入）</h2>
          <p className="dim">
            这个应用本身不调用任何 AI。把它注册为 MCP server 后，你可以在 Claude Code / Claude Desktop 里直接把银行账单丢给 AI，让它解析并通过
            <code> import_transactions</code> 等工具写入这里（自动去重，可撤销）。
          </p>
          <pre
            style={{
              background: "var(--bg-inset)",
              padding: 10,
              borderRadius: 8,
              fontSize: 12,
              overflowX: "auto",
              marginTop: 8,
            }}
          >{`claude mcp add my-money -- npm run mcp -w packages/server
# 或项目根目录的 .mcp.json 已配置好，Claude Code 打开本项目即自动可用`}</pre>
          <p className="dim" style={{ marginTop: 8 }}>
            工具：list_accounts · create_account · import_transactions · list_transactions · set_category · mark_transfer ·
            link_transfer_pair · link_refund_pair · get_summary · undo_import · set_fx_rate
          </p>
        </div>

        <div className="card">
          <h2>Exchange rates → CAD</h2>
          <p className="dim">Used to convert foreign-currency accounts in the net-worth total. Edit any time.</p>
          <table className="table">
            <tbody>
              {fx.map((r) => (
                <tr key={r.currency}>
                  <td style={{ width: 70 }}>{r.currency}</td>
                  <td>
                    <input
                      style={{ width: 110 }}
                      defaultValue={r.rate_to_cad}
                      onBlur={async (e) => {
                        const v = parseFloat(e.target.value);
                        if (v > 0 && v !== r.rate_to_cad) {
                          await api.put("/fx-rates", { rates: [{ currency: r.currency, rate_to_cad: v }] });
                          load();
                        }
                      }}
                    />
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button style={{ padding: "3px 8px" }} onClick={async () => { await api.del(`/fx-rates/${r.currency}`); load(); }}>
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
              <tr>
                <td>
                  <input style={{ width: 60 }} maxLength={3} placeholder="USD" value={newFx.currency} onChange={(e) => setNewFx({ ...newFx, currency: e.target.value.toUpperCase() })} />
                </td>
                <td>
                  <input style={{ width: 110 }} placeholder="1.37" value={newFx.rate} onChange={(e) => setNewFx({ ...newFx, rate: e.target.value })} />
                </td>
                <td style={{ textAlign: "right" }}>
                  <button
                    style={{ padding: "3px 8px" }}
                    disabled={newFx.currency.length !== 3 || !(parseFloat(newFx.rate) > 0)}
                    onClick={async () => {
                      await api.put("/fx-rates", { rates: [{ currency: newFx.currency, rate_to_cad: parseFloat(newFx.rate) }] });
                      setNewFx({ currency: "", rate: "" });
                      load();
                    }}
                  >
                    <Plus size={13} />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2>Categories</h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 8 }}>
            {categories.map((c) => (
              <span key={c.id} className="chip" style={{ background: `${c.color}22`, color: c.color, cursor: "default" }}>
                {catEmoji(c.icon)} {c.name}
                {!c.is_system && (
                  <Trash2
                    size={11}
                    style={{ cursor: "pointer" }}
                    onClick={async () => {
                      if (confirm(`Delete category "${c.name}"? Transactions keep their history but become uncategorized.`)) {
                        await api.del(`/categories/${c.id}`);
                        load();
                      }
                    }}
                  />
                )}
              </span>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <input placeholder="New category…" value={newCat.name} onChange={(e) => setNewCat({ ...newCat, name: e.target.value })} />
            <select
              value={newCat.type}
              onChange={(e) => setNewCat({ ...newCat, type: e.target.value as CategoryType })}
              title="transfer categories are excluded from both spending and income"
            >
              <option value="expense">expense</option>
              <option value="income">income</option>
              <option value="transfer">transfer</option>
            </select>
            <button
              disabled={!newCat.name}
              onClick={async () => {
                await api.post("/categories", { name: newCat.name, type: newCat.type, color: "#6366f1", icon: "tag" });
                setNewCat({ name: "", type: "expense" });
                load();
              }}
            >
              <Plus size={13} />
            </button>
          </div>
        </div>

        <div className="card" style={{ gridColumn: "1 / -1" }}>
          <h2>Merchant rules ({rules.length})</h2>
          <p className="dim">Learned categorizations — matching merchants are categorized locally without AI calls. Your corrections always win over AI rules.</p>
          <div style={{ maxHeight: 300, overflowY: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Merchant pattern</th>
                  <th>Category</th>
                  <th>Source</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{r.pattern}</td>
                    <td>
                      <span className="chip" style={{ background: `${r.category_color}22`, color: r.category_color, cursor: "default" }}>
                        {r.category_name}
                      </span>
                    </td>
                    <td>
                      <span className="badge">{r.source}</span>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button style={{ padding: "3px 8px" }} onClick={async () => { await api.del(`/merchant-rules/${r.id}`); load(); }}>
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rules.length === 0 && <div className="empty-state">Rules appear here after your first categorized statement.</div>}
          </div>
        </div>
      </div>
    </>
  );
}
