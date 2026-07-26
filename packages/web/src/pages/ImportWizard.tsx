import { useEffect, useMemo, useState } from "react";
import { Loader2, Undo2, UploadCloud, CheckCircle2, Wand2 } from "lucide-react";
import type { ImportSpec } from "@my-money/shared";
import { api, fmtMoney, type AccountWithBalance, type AnalyzeResult, type Category } from "../api";

type Step = "upload" | "mapping" | "preview" | "done";
type ColRole = "ignore" | "date" | "description" | "amount" | "debit" | "credit" | "balance";

interface MappingState {
  roles: ColRole[];
  has_header: boolean;
  skip_rows: number;
  date_format: string;
  sign_convention: "outflow_negative" | "outflow_positive";
  parentheses_negative: boolean;
}

const DATE_FORMATS = ["yyyy-MM-dd", "M/d/yyyy", "MM/dd/yyyy", "d/M/yyyy", "dd/MM/yyyy", "yyyy/MM/dd", "MMM d, yyyy", "dd-MMM-yyyy"];

function specToMapping(spec: ImportSpec, colCount: number): MappingState {
  const roles: ColRole[] = Array.from({ length: colCount }, () => "ignore");
  const set = (i: number, r: ColRole) => {
    if (i >= 0 && i < colCount) roles[i] = r;
  };
  set(spec.date.column, "date");
  for (const d of spec.description_columns) set(d, "description");
  if (spec.amount.mode === "single") set(spec.amount.column, "amount");
  else {
    set(spec.amount.debit_column, "debit");
    set(spec.amount.credit_column, "credit");
  }
  if (spec.balance_column !== null) set(spec.balance_column, "balance");
  return {
    roles,
    has_header: spec.has_header,
    skip_rows: spec.skip_rows,
    date_format: spec.date.format,
    sign_convention: spec.amount.mode === "single" ? spec.amount.sign_convention : "outflow_negative",
    parentheses_negative: spec.parentheses_negative,
  };
}

function mappingToSpec(m: MappingState, base: ImportSpec | null): ImportSpec | string {
  const dateCol = m.roles.indexOf("date");
  if (dateCol < 0) return "Pick a date column";
  const descCols = m.roles.map((r, i) => (r === "description" ? i : -1)).filter((i) => i >= 0);
  if (descCols.length === 0) return "Pick at least one description column";
  const amountCol = m.roles.indexOf("amount");
  const debitCol = m.roles.indexOf("debit");
  const creditCol = m.roles.indexOf("credit");
  let amount: ImportSpec["amount"];
  if (amountCol >= 0) amount = { mode: "single", column: amountCol, sign_convention: m.sign_convention };
  else if (debitCol >= 0 && creditCol >= 0) amount = { mode: "debit_credit", debit_column: debitCol, credit_column: creditCol };
  else return "Pick an amount column (or both debit and credit columns)";
  const balCol = m.roles.indexOf("balance");
  return {
    bank_guess: base?.bank_guess ?? null,
    delimiter: base?.delimiter ?? ",",
    has_header: m.has_header,
    skip_rows: m.skip_rows,
    date: { column: dateCol, format: m.date_format },
    description_columns: descCols,
    amount,
    balance_column: balCol >= 0 ? balCol : null,
    currency_guess: base?.currency_guess ?? null,
    parentheses_negative: m.parentheses_negative,
    thousands_separator: base?.thousands_separator ?? ",",
  };
}

export default function ImportWizard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>("upload");
  const [accounts, setAccounts] = useState<AccountWithBalance[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [accountId, setAccountId] = useState<number | "">("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null);
  const [mapping, setMapping] = useState<MappingState | null>(null);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [overrides, setOverrides] = useState<Record<number, number | null>>({});
  const [pickerRow, setPickerRow] = useState<number | null>(null);
  const [result, setResult] = useState<{ import_id: number; inserted: number; skipped: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    api.get<AccountWithBalance[]>("/accounts").then(setAccounts).catch(console.error);
    api.get<Category[]>("/categories").then(setCategories).catch(console.error);
  }, []);

  const spec = analysis?.spec as ImportSpec | undefined;
  const colCount = useMemo(() => Math.max(0, ...(analysis?.columns_preview ?? []).map((r) => r.length)), [analysis]);

  const analyze = async (withSpec?: ImportSpec) => {
    if (!file || accountId === "") return;
    setBusy(true);
    setError("");
    try {
      const r = await api.analyzeImport(file, accountId, withSpec);
      setAnalysis(r);
      setExcluded(new Set());
      setOverrides({});
      if (r.validation.ok) setStep("preview");
      else {
        setMapping(specToMapping(r.spec as ImportSpec, Math.max(0, ...r.columns_preview.map((x) => x.length))));
        setError(r.validation.message ?? "Parsing failed — adjust the column mapping.");
        setStep("mapping");
      }
    } catch (e) {
      const err = e as Error & { detail?: { needs_manual_mapping?: boolean; columns_preview?: string[][] } };
      if (err.detail?.needs_manual_mapping && err.detail.columns_preview) {
        const cols = Math.max(0, ...err.detail.columns_preview.map((x) => x.length));
        setAnalysis({
          columns_preview: err.detail.columns_preview,
          rows: [],
          validation: { ok: false, parse_rate: 0, balance_check: "n/a" },
          spec: null,
          new_count: 0,
          duplicate_count: 0,
        } as unknown as AnalyzeResult);
        setMapping({
          roles: Array.from({ length: cols }, () => "ignore"),
          has_header: true,
          skip_rows: 0,
          date_format: "yyyy-MM-dd",
          sign_convention: "outflow_negative",
          parentheses_negative: false,
        });
        setError("New format — map the columns below once; it's remembered for next time. (Or import via the MCP server and let the AI parse it.)");
        setStep("mapping");
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmImport = async () => {
    if (!analysis) return;
    setBusy(true);
    setError("");
    try {
      const r = await api.post<{ import_id: number; inserted: number; skipped: number }>("/imports/confirm", {
        staging_token: analysis.staging_token,
        excluded_row_indexes: [...excluded],
        category_overrides: Object.fromEntries(Object.entries(overrides).map(([k, v]) => [String(k), v])),
      });
      setResult(r);
      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!result) return;
    await api.post(`/imports/${result.import_id}/undo`);
    setResult(null);
    setStep("upload");
    setFile(null);
    setAnalysis(null);
  };

  const reset = () => {
    setStep("upload");
    setFile(null);
    setAnalysis(null);
    setMapping(null);
    setError("");
    setResult(null);
  };

  const stepIdx = ["upload", "mapping", "preview", "done"].indexOf(step);

  return (
    <>
      <div className="page-head">
        <h1>Import statement</h1>
        {step !== "upload" && <button onClick={reset}>Start over</button>}
      </div>

      <div className="steps">
        {["1 · File", "2 · Format", "3 · Preview", "4 · Done"].map((label, i) => (
          <div key={label} className={`step ${i === stepIdx ? "active" : i < stepIdx ? "done" : ""}`}>
            {label}
          </div>
        ))}
      </div>

      {error && <div className="alert error">{error}</div>}

      {step === "upload" && (
        <div className="card">
          <div className="form-row" style={{ maxWidth: 340 }}>
            <label>Import into account</label>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">— choose account —</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.currency})
                </option>
              ))}
            </select>
          </div>
          <div
            className={`dropzone ${dragOver ? "over" : ""}`}
            onClick={() => document.getElementById("file-input")?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files[0];
              if (f) setFile(f);
            }}
          >
            <UploadCloud size={36} style={{ marginBottom: 8 }} />
            <div>{file ? file.name : "Drop a bank CSV here, or click to choose"}</div>
            <div className="faint" style={{ marginTop: 6 }}>
              Everything is parsed locally. New formats need a one-time column mapping (remembered afterwards) — or import via the MCP
              server and let your AI assistant do the parsing.
            </div>
            <input
              id="file-input"
              type="file"
              accept=".csv,.txt"
              hidden
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
            <button className="primary" disabled={!file || accountId === "" || busy} onClick={() => analyze()}>
              {busy ? <Loader2 size={14} className="spin" style={{ verticalAlign: -2 }} /> : <Wand2 size={14} style={{ verticalAlign: -2 }} />} Analyze
            </button>
          </div>
        </div>
      )}

      {step === "mapping" && analysis && mapping && (
        <div className="card">
          <h2>Column mapping</h2>
          <p className="dim">Assign a role to each column. The first rows of your file are shown below.</p>
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  {Array.from({ length: colCount }, (_, i) => (
                    <th key={i}>
                      <select
                        value={mapping.roles[i] ?? "ignore"}
                        onChange={(e) => {
                          const roles = [...mapping.roles];
                          roles[i] = e.target.value as ColRole;
                          setMapping({ ...mapping, roles });
                        }}
                      >
                        {(["ignore", "date", "description", "amount", "debit", "credit", "balance"] as ColRole[]).map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {analysis.columns_preview.map((row, ri) => (
                  <tr key={ri} style={mapping.has_header && ri === mapping.skip_rows ? { fontWeight: 600 } : undefined}>
                    {Array.from({ length: colCount }, (_, ci) => (
                      <td key={ci} className="dim" style={{ whiteSpace: "nowrap", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}>
                        {row[ci] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 14, alignItems: "center" }}>
            <label style={{ display: "flex", gap: 5, alignItems: "center" }}>
              <input type="checkbox" checked={mapping.has_header} onChange={(e) => setMapping({ ...mapping, has_header: e.target.checked })} />
              First row is a header
            </label>
            <label style={{ display: "flex", gap: 5, alignItems: "center" }}>
              Skip rows:
              <input
                type="number"
                min={0}
                style={{ width: 60 }}
                value={mapping.skip_rows}
                onChange={(e) => setMapping({ ...mapping, skip_rows: Number(e.target.value) })}
              />
            </label>
            <label style={{ display: "flex", gap: 5, alignItems: "center" }}>
              Date format:
              <select value={mapping.date_format} onChange={(e) => setMapping({ ...mapping, date_format: e.target.value })}>
                {[mapping.date_format, ...DATE_FORMATS.filter((f) => f !== mapping.date_format)].map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
            {mapping.roles.includes("amount") && (
              <label style={{ display: "flex", gap: 5, alignItems: "center" }}>
                Spending appears as:
                <select
                  value={mapping.sign_convention}
                  onChange={(e) => setMapping({ ...mapping, sign_convention: e.target.value as MappingState["sign_convention"] })}
                >
                  <option value="outflow_negative">negative numbers</option>
                  <option value="outflow_positive">positive numbers (credit cards)</option>
                </select>
              </label>
            )}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                const s = mappingToSpec(mapping, spec ?? null);
                if (typeof s === "string") setError(s);
                else analyze(s);
              }}
            >
              {busy ? <Loader2 size={14} className="spin" style={{ verticalAlign: -2 }} /> : null} Re-parse with this mapping
            </button>
          </div>
        </div>
      )}

      {step === "preview" && analysis && (
        <>
          {analysis.file_already_imported && (
            <div className="alert warn">This exact file was already imported into this account before — everything below is likely a duplicate.</div>
          )}
          <div className="alert info">
            {analysis.spec_source === "cache" && "Known format — parsed with the saved column mapping. "}
            {analysis.spec_source === "manual" && "Parsed with your column mapping. "}
            {analysis.new_count} new · {analysis.duplicate_count} duplicates skipped
            {analysis.parse_errors.length > 0 ? ` · ${analysis.parse_errors.length} rows failed to parse` : ""}
          </div>
          <div className="card" style={{ padding: 0, maxHeight: 480, overflowY: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th />
                  <th>Date</th>
                  <th>Description</th>
                  <th>Category</th>
                  <th style={{ textAlign: "right" }}>Amount</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {analysis.rows.map((r) => {
                  const catId = r.row_index in overrides ? overrides[r.row_index] : r.category_id;
                  const cat = categories.find((c) => c.id === catId);
                  return (
                    <tr key={r.row_index} style={r.duplicate || excluded.has(r.row_index) ? { opacity: 0.45 } : undefined}>
                      <td>
                        {!r.duplicate && (
                          <input
                            type="checkbox"
                            checked={!excluded.has(r.row_index)}
                            onChange={(e) => {
                              const next = new Set(excluded);
                              if (e.target.checked) next.delete(r.row_index);
                              else next.add(r.row_index);
                              setExcluded(next);
                            }}
                          />
                        )}
                      </td>
                      <td className="dim" style={{ whiteSpace: "nowrap" }}>{r.posted_date}</td>
                      <td style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.description_raw}>
                        {r.description_raw}
                        {r.duplicate && <span className="badge" style={{ marginLeft: 6 }}>duplicate</span>}
                      </td>
                      <td>
                        {!r.duplicate && (
                          <button className="chip" style={cat ? { background: `${cat.color}22`, color: cat.color } : {}} onClick={() => setPickerRow(r.row_index)}>
                            {cat?.name ?? "— pick —"}
                          </button>
                        )}
                      </td>
                      <td className={`money ${r.amount_cents >= 0 ? "pos" : ""}`} style={{ textAlign: "right" }}>
                        {fmtMoney(r.amount_cents, undefined, true)}
                      </td>
                      <td />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 14 }}>
            <button
              onClick={() => {
                setMapping(specToMapping(spec!, colCount));
                setStep("mapping");
              }}
              disabled={!spec}
            >
              Adjust column mapping
            </button>
            <button className="primary" disabled={busy || analysis.new_count === 0} onClick={confirmImport}>
              {busy ? <Loader2 size={14} className="spin" style={{ verticalAlign: -2 }} /> : null} Import{" "}
              {analysis.new_count - [...excluded].filter((i) => !analysis.rows.find((r) => r.row_index === i)?.duplicate).length} transactions
            </button>
          </div>
        </>
      )}

      {step === "done" && result && (
        <div className="card" style={{ textAlign: "center", padding: 40 }}>
          <CheckCircle2 size={40} style={{ color: "var(--green)", marginBottom: 10 }} />
          <h2>Imported {result.inserted} transactions</h2>
          <p className="dim">{result.skipped} duplicates/excluded rows skipped.</p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 16 }}>
            <button onClick={undo}>
              <Undo2 size={14} style={{ verticalAlign: -2 }} /> Undo this import
            </button>
            <button onClick={reset}>Import another file</button>
            <button className="primary" onClick={onDone}>
              View transactions
            </button>
          </div>
        </div>
      )}

      {pickerRow !== null && analysis && (
        <div className="modal-backdrop" onClick={() => setPickerRow(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 12 }}>Category</h2>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
              {categories.map((c) => (
                <button
                  key={c.id}
                  className="chip"
                  style={{ background: `${c.color}22`, color: c.color }}
                  onClick={() => {
                    setOverrides({ ...overrides, [pickerRow]: c.id });
                    setPickerRow(null);
                  }}
                >
                  {c.name}
                </button>
              ))}
              <button
                className="chip"
                onClick={() => {
                  setOverrides({ ...overrides, [pickerRow]: null });
                  setPickerRow(null);
                }}
              >
                clear
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
