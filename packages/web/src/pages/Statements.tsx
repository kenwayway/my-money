import { Fragment, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import {
  monthDateBounds,
  statementCycleCoverage,
  type StatementDateRange,
} from "@my-money/shared";
import {
  AlertTriangle,
  CalendarRange,
  CalendarX2,
  CheckCircle2,
  ChevronRight,
  Copy,
  Download,
  FileCheck2,
  Files,
  FileUp,
  FolderOpen,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  api,
  fmtMoney,
  type AccountWithBalance,
  type StatementDocument,
  type StatementDetail,
  type StatementRecord,
} from "../api";

const VISIBLE_MONTHS = 12;

function statusMeta(statement: StatementRecord) {
  if (statement.status === "undone") {
    return { label: "Undone", tone: "muted", glyph: "×", icon: <RotateCcw size={13} /> };
  }
  if (statement.reconciliation_status === "matched") {
    return { label: "Balance verified", tone: "ok", glyph: "✓", icon: <CheckCircle2 size={13} /> };
  }
  if (statement.reconciliation_status === "mismatch") {
    return { label: "Balance differs", tone: "danger", glyph: "!", icon: <AlertTriangle size={13} /> };
  }
  return { label: "On file", tone: "neutral", glyph: "•", icon: <FileCheck2 size={13} /> };
}

function periodLabel(statement: StatementRecord) {
  if (!statement.statement_start_date && !statement.statement_end_date) return "Period unavailable";
  if (!statement.statement_start_date) return `Through ${statement.statement_end_date}`;
  if (!statement.statement_end_date || statement.statement_start_date === statement.statement_end_date) {
    return statement.statement_start_date;
  }
  return `${statement.statement_start_date} → ${statement.statement_end_date}`;
}

function monthKeyFromDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(key: string, amount: number) {
  const [year, month] = key.split("-").map(Number);
  const shifted = new Date(year!, month! - 1 + amount, 1, 12);
  return monthKeyFromDate(shifted);
}

function monthLabel(key: string, includeYear = false) {
  const [year, month] = key.split("-").map(Number);
  const label = new Intl.DateTimeFormat("en-CA", {
    month: includeYear ? "long" : "short",
    ...(includeYear ? { year: "numeric" } : {}),
  }).format(new Date(year!, month! - 1, 1, 12));
  return label;
}

function monthsBetween(start: string, end: string) {
  if (start > end) return [];
  const months: string[] = [];
  let cursor = start;
  while (cursor <= end && months.length < 600) {
    months.push(cursor);
    cursor = shiftMonth(cursor, 1);
  }
  return months;
}

function statementMonth(statement: StatementRecord) {
  return (statement.statement_end_date ?? statement.statement_start_date)?.slice(0, 7) ?? null;
}

function statementRange(
  statement: StatementRecord
): StatementDateRange | null {
  const start = statement.statement_start_date ?? statement.statement_end_date;
  const end = statement.statement_end_date ?? statement.statement_start_date;
  if (!start || !end) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

interface CoverageCell {
  statements: StatementRecord[];
  coveredDays: number;
  totalDays: number;
  status: "partial" | "full";
  hasPrimaryStatement: boolean;
}

interface CoverageAccount {
  account: AccountWithBalance;
  startMonth: string;
  statements: StatementRecord[];
  cells: Map<string, CoverageCell>;
  missingMonths: string[];
  partialMonths: string[];
  expectedCount: number;
  importedCount: number;
}

export default function Statements() {
  const [statements, setStatements] = useState<StatementRecord[]>([]);
  const [documents, setDocuments] = useState<StatementDocument[]>([]);
  const [accounts, setAccounts] = useState<AccountWithBalance[]>([]);
  const [detail, setDetail] = useState<StatementDetail | null>(null);
  const [reconciling, setReconciling] = useState<StatementRecord | null>(null);
  const [editingPeriod, setEditingPeriod] = useState<StatementRecord | null>(null);
  const [showUndone, setShowUndone] = useState(false);
  const [endDate, setEndDate] = useState("");
  const [periodStartDate, setPeriodStartDate] = useState("");
  const [periodEndDate, setPeriodEndDate] = useState("");
  const [closingBalance, setClosingBalance] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [attachStatement, setAttachStatement] = useState<StatementRecord | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const [nextStatements, nextDocuments, nextAccounts] = await Promise.all([
        api.get<StatementRecord[]>("/statements"),
        api.get<StatementDocument[]>("/statement-documents"),
        api.get<AccountWithBalance[]>("/accounts"),
      ]);
      setStatements(nextStatements);
      setDocuments(nextDocuments);
      setAccounts(nextAccounts);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    load();
    const refresh = () => load();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  const upload = async () => {
    if (!uploadFile) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.set("file", uploadFile);
      if (attachStatement) form.set("import_id", String(attachStatement.id));
      await api.postForm<StatementDocument>("/statement-documents", form);
      const attachedImportId = attachStatement?.id;
      setShowUpload(false);
      setAttachStatement(null);
      setUploadFile(null);
      await load();
      if (attachedImportId) {
        setDetail(await api.get<StatementDetail>(`/statements/${attachedImportId}`));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteDocument = async (
    document: Pick<StatementDocument, "id" | "original_name">
  ) => {
    if (!confirm(`Delete the stored original "${document.original_name}"? Imported transactions will be kept.`)) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.del(`/statement-documents/${document.id}`);
      if (detail?.statement.document_id === document.id) setDetail(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyPrompt = async (document: StatementDocument) => {
    const prompt =
      `Use the my-money MCP server to read and import pending statement document #${document.id} ` +
      `("${document.original_name}"). ` +
      (document.account_name
        ? `Import it into account "${document.account_name}". `
        : "Choose the correct account after reading the statement. ") +
      "Preserve the exact printed statement start/end dates, reconcile against the closing balance, and report any mismatch.";
    try {
      await navigator.clipboard.writeText(prompt);
      setCopiedId(document.id);
      window.setTimeout(() => setCopiedId((id) => (id === document.id ? null : id)), 1800);
    } catch {
      setError("Could not copy the prompt. Your browser may have blocked clipboard access.");
    }
  };

  const openUpload = () => {
    setError("");
    setAttachStatement(null);
    setUploadFile(null);
    setShowUpload(true);
  };

  const openAttachmentUpload = (statement: StatementRecord) => {
    setError("");
    setAttachStatement(statement);
    setUploadFile(null);
    setShowUpload(true);
  };

  const active = useMemo(
    () => statements.filter((statement) => statement.status === "committed"),
    [statements]
  );
  const currentMonth = monthKeyFromDate(new Date());
  const lastCompletedMonth = shiftMonth(currentMonth, -1);
  const visibleMonths = useMemo(
    () => Array.from({ length: VISIBLE_MONTHS }, (_, index) => shiftMonth(currentMonth, index - VISIBLE_MONTHS + 1)),
    [currentMonth]
  );

  const coverage = useMemo<CoverageAccount[]>(() => {
    const byAccount = new Map<number, StatementRecord[]>();
    for (const statement of active) {
      const rows = byAccount.get(statement.account_id) ?? [];
      rows.push(statement);
      byAccount.set(statement.account_id, rows);
    }

    return accounts
      .filter((account) => account.type !== "investment" && account.type !== "cash")
      .map((account) => {
        const rows = byAccount.get(account.id) ?? [];
        const ranges = rows.flatMap((statement) => {
          const range = statementRange(statement);
          return range ? [{ statement, range }] : [];
        });
        const statementMonths = ranges
          .flatMap(({ range }) => [range.start.slice(0, 7), range.end.slice(0, 7)])
          .sort();
        const createdMonth = monthKeyFromDate(new Date(account.created_at * 1000));
        const startCandidates = [
          account.opening_balance_date?.slice(0, 7),
          statementMonths[0],
          createdMonth,
        ].filter((value): value is string => Boolean(value));
        const startMonth = startCandidates.sort()[0] ?? currentMonth;
        const expectedMonths = monthsBetween(startMonth, lastCompletedMonth);
        const cells = new Map<string, CoverageCell>();
        for (const month of monthsBetween(startMonth, currentMonth)) {
          const bounds = monthDateBounds(month);
          const overlapping = ranges.filter(
            ({ range }) => range.start <= bounds.end && range.end >= bounds.start
          );
          if (overlapping.length === 0) continue;
          const result = statementCycleCoverage(
            month,
            overlapping.map(({ range }) => range)
          );
          if (result.status === "none") continue;
          cells.set(month, {
            statements: overlapping
              .map(({ statement }) => statement)
              .sort((a, b) => b.created_at - a.created_at || b.id - a.id),
            coveredDays: result.coveredDays,
            totalDays: result.totalDays,
            status: result.status,
            hasPrimaryStatement: result.hasPrimaryStatement,
          });
        }
        const importedCount = expectedMonths.filter((month) => cells.has(month)).length;

        return {
          account,
          startMonth,
          statements: rows,
          cells,
          missingMonths: expectedMonths.filter((month) => !cells.has(month)),
          partialMonths: expectedMonths.filter(
            (month) => cells.get(month)?.status === "partial"
          ),
          expectedCount: expectedMonths.length,
          importedCount,
        };
      })
      .sort((a, b) => {
        const attentionA = a.missingMonths.length + a.partialMonths.length + a.statements.filter((s) => s.reconciliation_status === "mismatch").length;
        const attentionB = b.missingMonths.length + b.partialMonths.length + b.statements.filter((s) => s.reconciliation_status === "mismatch").length;
        return attentionB - attentionA || a.account.name.localeCompare(b.account.name);
      });
  }, [accounts, active, currentMonth, lastCompletedMonth]);

  const expectedMonths = coverage.reduce((sum, row) => sum + row.expectedCount, 0);
  const importedMonths = coverage.reduce((sum, row) => sum + row.importedCount, 0);
  const missingMonths = expectedMonths - importedMonths;
  const partialMonths = coverage.reduce((sum, row) => sum + row.partialMonths.length, 0);
  const coveragePercent = expectedMonths === 0 ? 100 : Math.round((importedMonths / expectedMonths) * 100);
  const mismatches = active.filter((statement) => statement.reconciliation_status === "mismatch").length;
  const undoneCount = statements.filter((statement) => statement.status === "undone").length;

  const history = useMemo(
    () =>
      statements
        .filter((statement) => showUndone || statement.status === "committed")
        .sort((a, b) => {
          const dateA = a.statement_end_date ?? a.statement_start_date ?? "";
          const dateB = b.statement_end_date ?? b.statement_start_date ?? "";
          return dateB.localeCompare(dateA) || b.created_at - a.created_at;
        }),
    [showUndone, statements]
  );
  const historyGroups = useMemo(() => {
    const grouped = new Map<string, StatementRecord[]>();
    for (const statement of history) {
      const month = statementMonth(statement) ?? "unknown";
      const rows = grouped.get(month) ?? [];
      rows.push(statement);
      grouped.set(month, rows);
    }
    return [...grouped.entries()]
      .sort(([monthA], [monthB]) => {
        if (monthA === "unknown") return 1;
        if (monthB === "unknown") return -1;
        return monthB.localeCompare(monthA);
      })
      .map(([month, rows]) => ({
        month,
        rows,
        accountCount: new Set(rows.map((statement) => statement.account_id)).size,
        expectedAccountCount:
          month === "unknown"
            ? 0
            : coverage.filter((row) => row.startMonth <= month).length,
      }));
  }, [coverage, history]);

  const openDetail = async (id: number) => {
    setError("");
    try {
      setDetail(await api.get<StatementDetail>(`/statements/${id}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const openReconcile = (statement: StatementRecord) => {
    setDetail(null);
    setReconciling(statement);
    setEndDate(statement.statement_end_date ?? format(new Date(), "yyyy-MM-dd"));
    setClosingBalance(
      statement.statement_balance_cents === null
        ? ""
        : (statement.statement_balance_cents / 100).toFixed(2)
    );
    setError("");
  };

  const openPeriodEditor = (statement: StatementRecord) => {
    setEditingPeriod(statement);
    setPeriodStartDate(
      statement.statement_start_date ??
        statement.statement_end_date ??
        format(new Date(), "yyyy-MM-dd")
    );
    setPeriodEndDate(
      statement.statement_end_date ??
        statement.statement_start_date ??
        format(new Date(), "yyyy-MM-dd")
    );
    setError("");
  };

  const savePeriod = async () => {
    if (!editingPeriod) return;
    setBusy(true);
    setError("");
    try {
      await api.patch<StatementRecord>(`/statements/${editingPeriod.id}/period`, {
        statement_start_date: periodStartDate,
        statement_end_date: periodEndDate,
      });
      const id = editingPeriod.id;
      setEditingPeriod(null);
      await load();
      setDetail(await api.get<StatementDetail>(`/statements/${id}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const reconcile = async () => {
    if (!reconciling) return;
    const parsed = Number(closingBalance.replace(/[$, ]/g, ""));
    if (!Number.isFinite(parsed)) {
      setError("Enter a valid closing balance.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.post<StatementRecord>(`/statements/${reconciling.id}/reconcile`, {
        statement_end_date: endDate,
        statement_balance_cents: Math.round(parsed * 100),
      });
      setReconciling(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const undo = async (statement: StatementRecord) => {
    if (!confirm(`Undo "${statement.file_name}"? Its ${statement.inserted_count} transactions will be deleted.`)) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.post(`/statements/${statement.id}/undo`);
      setDetail(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head statement-page-head">
        <div>
          <h1>Statement Center</h1>
          <div className="faint">See missing months first. Open a statement only when you need the details.</div>
        </div>
        <button className="primary" onClick={openUpload}>
          <Upload size={14} /> Upload PDF or CSV
        </button>
      </div>

      {error && <div className="alert error">{error}</div>}

      <div className="statement-stats">
        <div className={`card ${missingMonths > 0 ? "attention" : ""}`}>
          <span className="statement-stat-icon warn"><CalendarX2 size={17} /></span>
          <div><strong>{missingMonths}</strong><span>Missing months</span></div>
        </div>
        <div className="card">
          <span className="statement-stat-icon ok"><ShieldCheck size={17} /></span>
          <div>
            <strong>{coveragePercent}%</strong>
            <span>
              {importedMonths} of {expectedMonths} months with coverage
              {partialMonths > 0 ? ` · ${partialMonths} partial` : ""}
            </span>
          </div>
        </div>
        <div className={`card ${mismatches > 0 ? "attention" : ""}`}>
          <span className="statement-stat-icon danger"><AlertTriangle size={17} /></span>
          <div><strong>{mismatches}</strong><span>Balance issues</span></div>
        </div>
      </div>

      <section className="card statement-inbox">
        <div className="statement-section-head">
          <div>
            <h2>Statement inbox</h2>
            <p>Drop in a PDF or CSV. Your connected AI reads it, chooses the account, and imports it through MCP.</p>
          </div>
          <span className={`statement-inbox-count ${documents.length > 0 ? "attention" : ""}`}>
            {documents.length} pending
          </span>
        </div>
        {documents.length > 0 ? (
          <div className="statement-document-list">
            {documents.map((document) => (
              <div className="statement-document-row" key={document.id}>
                <span className="statement-document-icon"><Files size={17} /></span>
                <div className="statement-document-main">
                  <strong>{document.original_name}</strong>
                  <span>
                    {document.account_name ?? "Account will be chosen by AI"} · {(document.size_bytes / 1024).toFixed(0)} KB · uploaded{" "}
                    {format(new Date(document.uploaded_at * 1000), "MMM d, yyyy")}
                  </span>
                </div>
                <span className={`statement-status ${document.processing_status === "undone" ? "muted" : "neutral"}`}>
                  {document.processing_status === "undone" ? <RotateCcw size={12} /> : <FileUp size={12} />}
                  {document.processing_status === "undone" ? "Needs re-import" : "Pending"}
                </span>
                <div className="statement-document-actions">
                  <button
                    title="View original file"
                    onClick={() => window.open(`/api/statement-documents/${document.id}/file`, "_blank", "noopener,noreferrer")}
                  >
                    <FolderOpen size={13} />
                  </button>
                  <button title="Copy AI prompt" onClick={() => copyPrompt(document)}>
                    {copiedId === document.id ? <CheckCircle2 size={13} /> : <Copy size={13} />}
                    <span>{copiedId === document.id ? "Copied" : "Copy AI prompt"}</span>
                  </button>
                  <button
                    className="danger-quiet"
                    title="Delete stored file"
                    disabled={busy}
                    onClick={() => deleteDocument(document)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="statement-inbox-empty">
            <CheckCircle2 size={16} />
            No statement files are waiting for AI processing.
          </div>
        )}
      </section>

      <section className="card statement-coverage">
        <div className="statement-section-head">
          <div>
            <h2>Monthly coverage</h2>
            <p>Previous months are expected. The current month is never marked missing.</p>
          </div>
          <div className="coverage-legend" aria-label="Coverage legend">
            <span><i className="ok">✓</i> Verified</span>
            <span><i className="neutral">•</i> On file</span>
            <span><i className="partial">◐</i> Partial</span>
            <span><i className="danger">!</i> Balance differs</span>
            <span><i className="missing">—</i> Missing</span>
          </div>
        </div>

        <div className="coverage-scroll">
          <div className="coverage-grid">
            <div className="coverage-corner">Account</div>
            {visibleMonths.map((month) => (
              <div className={`coverage-month ${month === currentMonth ? "current" : ""}`} key={month}>
                <span>{monthLabel(month)}</span>
                <small>{month.slice(0, 4)}</small>
              </div>
            ))}

            {coverage.map((row) => (
              <div className="coverage-row" key={row.account.id}>
                <div className="coverage-account">
                  <i className="account-color-bar" style={{ background: row.account.color }} />
                  <div>
                    <strong>{row.account.name}</strong>
                    <span>
                      {row.missingMonths.length > 0
                        ? `${row.missingMonths.length} missing: ${row.missingMonths.slice(-3).map((month) => monthLabel(month, true)).join(", ")}${row.missingMonths.length > 3 ? "…" : ""}`
                        : row.partialMonths.length > 0
                          ? `${row.partialMonths.length} partial: ${row.partialMonths.slice(-3).map((month) => monthLabel(month, true)).join(", ")}${row.partialMonths.length > 3 ? "…" : ""}`
                        : row.expectedCount === 0
                          ? "Tracking starts this month"
                          : "Up to date"}
                    </span>
                  </div>
                </div>

                {visibleMonths.map((month) => {
                  const cell = row.cells.get(month);
                  if (cell) {
                    const mismatch = cell.statements.some(
                      (statement) => statement.reconciliation_status === "mismatch"
                    );
                    const verified = cell.statements.every(
                      (statement) => statement.reconciliation_status === "matched"
                    );
                    const tone = mismatch
                      ? "danger"
                      : cell.status === "partial"
                        ? "partial"
                        : verified
                          ? "ok"
                          : "neutral";
                    const label = mismatch
                      ? "Balance differs"
                      : cell.status === "partial"
                        ? `${cell.coveredDays} of ${cell.totalDays} days covered`
                        : verified
                          ? "Balance verified"
                          : "On file";
                    const glyph = mismatch
                      ? "!"
                      : cell.status === "partial"
                        ? `${cell.coveredDays}d`
                        : verified
                          ? "✓"
                          : "•";
                    const statement = cell.statements[0]!;
                    const calendarPart =
                      cell.coveredDays < cell.totalDays
                        ? ` · ${cell.coveredDays}/${cell.totalDays} calendar days represented`
                        : "";
                    return (
                      <button
                        className={`coverage-cell ${tone} ${cell.status === "partial" ? "partial-range" : ""}`}
                        key={month}
                        title={`${row.account.name} · ${monthLabel(month, true)} · ${label}${cell.hasPrimaryStatement ? " · statement cycle ends this month" : calendarPart} · ${cell.statements.length} statement${cell.statements.length === 1 ? "" : "s"}`}
                        aria-label={`${row.account.name}, ${monthLabel(month, true)}: ${label}`}
                        onClick={() => openDetail(statement.id)}
                        style={
                          cell.status === "partial"
                            ? { "--coverage": `${Math.round((cell.coveredDays / cell.totalDays) * 100)}%` } as React.CSSProperties
                            : undefined
                        }
                      >
                        {glyph}
                      </button>
                    );
                  }
                  if (month === currentMonth) {
                    return <span className="coverage-cell current" key={month} title="Current cycle — not due">now</span>;
                  }
                  if (month < row.startMonth) {
                    return <span className="coverage-cell na" key={month} title="Not tracked yet">·</span>;
                  }
                  return (
                    <span
                      className="coverage-cell missing"
                      key={month}
                      title={`${row.account.name} · ${monthLabel(month, true)} · Missing`}
                    >
                      —
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {coverage.length === 0 && (
          <div className="empty-state">No statement-based accounts to track.</div>
        )}
      </section>

      <section className="card statement-history">
        <div className="statement-section-head">
          <div>
            <h2>Statement history</h2>
            <p>{active.length} active statement{active.length === 1 ? "" : "s"}</p>
          </div>
          {undoneCount > 0 && (
            <button className="statement-history-toggle" onClick={() => setShowUndone((value) => !value)}>
              {showUndone ? "Hide" : "Show"} {undoneCount} undone
            </button>
          )}
        </div>

        <div className="statement-table-wrap">
          <table className="table statement-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Statement period</th>
                <th>Balance</th>
                <th style={{ textAlign: "right" }}>Transactions</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {historyGroups.map((group) => (
                <Fragment key={group.month}>
                  <tr className="statement-month-group">
                    <td colSpan={5}>
                      <strong>{group.month === "unknown" ? "Unknown period" : monthLabel(group.month, true)}</strong>
                      <span>
                        {group.rows.length} statement{group.rows.length === 1 ? "" : "s"}
                        {group.month !== currentMonth && group.expectedAccountCount > 0
                          ? ` · ${group.accountCount} of ${group.expectedAccountCount} tracked accounts`
                          : ""}
                      </span>
                    </td>
                  </tr>
                  {group.rows.map((statement) => {
                    const meta = statusMeta(statement);
                    return (
                      <tr
                        key={statement.id}
                        className={statement.status === "undone" ? "statement-undone" : ""}
                        onClick={() => openDetail(statement.id)}
                      >
                        <td>
                          <div className="statement-account-cell">
                            <i className="account-color-bar" style={{ background: statement.account_color }} />
                            <div>
                              <strong>{statement.account_name}</strong>
                              <span>{statement.document_name ?? statement.file_name}</span>
                            </div>
                          </div>
                        </td>
                        <td><span className="statement-period">{periodLabel(statement)}</span></td>
                        <td>
                          <span className={`statement-status ${meta.tone}`}>{meta.icon}{meta.label}</span>
                          {statement.reconciliation_status === "mismatch" && statement.difference_cents !== null && (
                            <div className="statement-diff">
                              Off by {fmtMoney(statement.difference_cents, statement.account_currency, true)}
                            </div>
                          )}
                        </td>
                        <td className="money" style={{ textAlign: "right" }}>{statement.inserted_count}</td>
                        <td className="statement-open"><ChevronRight size={15} /></td>
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

        {history.length === 0 && (
          <div className="empty-state">No statements yet. Add one through MCP and it will appear here automatically.</div>
        )}
      </section>

      {detail && (
        <div className="modal-backdrop" onClick={() => setDetail(null)}>
          <div className="modal statement-detail-modal" onClick={(event) => event.stopPropagation()}>
            <div className="statement-detail-head">
              <div>
                <div className="inbox-kicker"><FileCheck2 size={13} /> Statement #{detail.statement.id}</div>
                <h2>{detail.statement.account_name}</h2>
                <div className="faint">{periodLabel(detail.statement)} · {detail.statement.document_name ?? detail.statement.file_name}</div>
              </div>
              <button title="Close" onClick={() => setDetail(null)}><X size={14} /></button>
            </div>
            <div className="statement-detail-grid">
              <div><span>Transactions</span><strong>{detail.statement.inserted_count} rows</strong></div>
              <div><span>Duplicates</span><strong>{detail.statement.skipped_dupes}</strong></div>
              <div><span>Statement balance</span><strong>{detail.statement.statement_balance_cents === null ? "Not supplied" : fmtMoney(detail.statement.statement_balance_cents, detail.statement.account_currency)}</strong></div>
              <div><span>Calculated balance</span><strong>{detail.statement.computed_balance_cents === null ? "Not checked" : fmtMoney(detail.statement.computed_balance_cents, detail.statement.account_currency)}</strong></div>
            </div>
            <div className="statement-detail-actions">
              <button onClick={() => openPeriodEditor(detail.statement)}>
                <CalendarRange size={13} /> Edit statement period
              </button>
              {detail.statement.document_id !== null && (
                <>
                  <button
                    onClick={() =>
                      window.open(
                        `/api/statement-documents/${detail.statement.document_id}/file`,
                        "_blank",
                        "noopener,noreferrer"
                      )
                    }
                  >
                    <FolderOpen size={13} /> View original file
                  </button>
                  <button
                    onClick={() => {
                      window.location.href = `/api/statement-documents/${detail.statement.document_id}/file?download=1`;
                    }}
                  >
                    <Download size={13} /> Download
                  </button>
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() =>
                      deleteDocument({
                        id: detail.statement.document_id!,
                        original_name: detail.statement.document_name ?? detail.statement.file_name,
                      })
                    }
                  >
                    <Trash2 size={13} /> Delete original
                  </button>
                </>
              )}
              {detail.statement.document_id === null && (
                <button className="primary" onClick={() => openAttachmentUpload(detail.statement)}>
                  <FileUp size={13} /> Attach original file
                </button>
              )}
              {detail.statement.status === "committed" && (
                <>
                  <button className="primary" onClick={() => openReconcile(detail.statement)}>Check historical balance</button>
                  <button disabled={busy} onClick={() => undo(detail.statement)}>Undo statement</button>
                </>
              )}
              {detail.statement.document_id === null && (
                <span className="faint">No original statement file is stored for this import.</span>
              )}
            </div>
            <div className="statement-detail-transactions">
              <table className="table">
                <thead><tr><th>Date</th><th>Description</th><th>Category</th><th style={{ textAlign: "right" }}>Amount</th></tr></thead>
                <tbody>
                  {detail.transactions.map((transaction) => (
                    <tr key={transaction.id}>
                      <td className="dim">{transaction.posted_date}</td>
                      <td>{transaction.description_raw}{transaction.is_transfer ? <span className="badge" style={{ marginLeft: 6 }}>transfer</span> : null}</td>
                      <td className="dim">{transaction.category_name ?? "Uncategorized"}</td>
                      <td className="money" style={{ textAlign: "right" }}>{fmtMoney(transaction.amount_cents, detail.statement.account_currency, true)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {detail.transactions.length === 0 && <div className="empty-state">No active transactions remain in this statement.</div>}
            </div>
          </div>
        </div>
      )}

      {editingPeriod && (
        <div className="modal-backdrop" onClick={() => !busy && setEditingPeriod(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="statement-detail-head">
              <div>
                <div className="inbox-kicker"><CalendarRange size={13} /> Statement #{editingPeriod.id}</div>
                <h2>Edit statement period</h2>
                <div className="faint">
                  Enter the billing-cycle dates printed on the statement. This changes coverage only—not transactions.
                </div>
              </div>
              <button title="Close" disabled={busy} onClick={() => setEditingPeriod(null)}>
                <X size={14} />
              </button>
            </div>
            {error && <div className="alert error">{error}</div>}
            <div className="form-grid-2">
              <div className="form-row">
                <label>Statement start date</label>
                <input
                  type="date"
                  value={periodStartDate}
                  onChange={(event) => setPeriodStartDate(event.target.value)}
                />
              </div>
              <div className="form-row">
                <label>Statement end date</label>
                <input
                  type="date"
                  value={periodEndDate}
                  onChange={(event) => setPeriodEndDate(event.target.value)}
                />
              </div>
            </div>
            <div className="statement-reconcile-note">
              The end month counts as the completed statement cycle. Any days carried into another calendar month appear there as partial coverage.
            </div>
            <div className="modal-actions">
              <button disabled={busy} onClick={() => setEditingPeriod(null)}>Cancel</button>
              <button
                className="primary"
                disabled={
                  busy ||
                  !periodStartDate ||
                  !periodEndDate ||
                  periodStartDate > periodEndDate
                }
                onClick={savePeriod}
              >
                {busy ? "Saving…" : "Save period"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showUpload && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!busy) {
              setShowUpload(false);
              setAttachStatement(null);
            }
          }}
        >
          <div className="modal statement-upload-modal" onClick={(event) => event.stopPropagation()}>
            <div className="statement-detail-head">
              <div>
                <div className="inbox-kicker">
                  <FileUp size={13} /> {attachStatement ? `Statement #${attachStatement.id}` : "Statement inbox"}
                </div>
                <h2>{attachStatement ? "Attach original file" : "Store a statement file"}</h2>
                <div className="faint">
                  {attachStatement
                    ? "Attach the original PDF or CSV. Transactions, categories, and reconciliation stay unchanged."
                    : "Upload a PDF or CSV. AI will read it and choose the account through MCP."}
                </div>
              </div>
              <button
                title="Close"
                disabled={busy}
                onClick={() => {
                  setShowUpload(false);
                  setAttachStatement(null);
                }}
              >
                <X size={14} />
              </button>
            </div>
            {error && <div className="alert error">{error}</div>}
            {attachStatement && (
              <div className="statement-attachment-account">
                <span>Existing statement</span>
                <strong>{attachStatement.account_name}</strong>
                <small>{periodLabel(attachStatement)} · transactions will not be changed</small>
              </div>
            )}
            <label
              className={`statement-dropzone ${dragging ? "dragging" : ""} ${uploadFile ? "selected" : ""}`}
              onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => { event.preventDefault(); setDragging(false); }}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                const file = event.dataTransfer.files[0];
                if (file) setUploadFile(file);
              }}
            >
              <input
                type="file"
                accept="application/pdf,text/csv,.pdf,.csv"
                onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)}
              />
              {uploadFile ? <FileCheck2 size={24} /> : <FileUp size={24} />}
              <strong>{uploadFile ? uploadFile.name : "Drop one PDF or CSV here"}</strong>
              <span>
                {uploadFile
                  ? `${(uploadFile.size / 1024 / 1024).toFixed(2)} MiB · click to choose another`
                  : "or click to browse · maximum 20 MiB"}
              </span>
            </label>
            <div className="modal-actions">
              <button
                disabled={busy}
                onClick={() => {
                  setShowUpload(false);
                  setAttachStatement(null);
                }}
              >
                Cancel
              </button>
              <button
                className="primary"
                disabled={busy || !uploadFile}
                onClick={upload}
              >
                {busy ? "Storing…" : attachStatement ? "Attach file" : "Store file"}
              </button>
            </div>
          </div>
        </div>
      )}

      {reconciling && (
        <div className="modal-backdrop" onClick={() => setReconciling(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h2>Check historical balance</h2>
            <p className="dim">
              Use the closing balance printed on this statement—not the balance currently shown in your bank app.
              If the statement does not include one, leave it as “On file”.
            </p>
            {error && <div className="alert error">{error}</div>}
            <div className="form-grid-2">
              <div className="form-row">
                <label>Statement end date</label>
                <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
              </div>
              <div className="form-row">
                <label>Closing balance ({reconciling.account_currency})</label>
                <input autoFocus placeholder="-523.10" value={closingBalance} onChange={(event) => setClosingBalance(event.target.value)} />
              </div>
            </div>
            <div className="statement-reconcile-note">
              Credit-card debt must be negative. The ledger will be compared at the end of {endDate || "that date"}.
            </div>
            <div className="modal-actions">
              <button onClick={() => setReconciling(null)}>Cancel</button>
              <button className="primary" disabled={busy || !endDate || !closingBalance} onClick={reconcile}>
                {busy ? "Checking…" : "Compare balance"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
