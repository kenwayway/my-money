import { Hono } from "hono";
import crypto from "node:crypto";
import { z } from "zod";
import { db, tx } from "../db/connection.js";
import { readCsvText, parseRows } from "../import/csvReader.js";
import { formatFingerprint, fileSha256 } from "../import/formatFingerprint.js";
import { applySpec } from "../import/specApply.js";
import { validateApply } from "../import/validate.js";
import { dedupeRows, type DedupedRow } from "../import/dedupe.js";
import { categorizeByRules } from "../services/categorizer.js";
import { ImportSpecSchema, type ImportSpec, type ParsedTxn, type CategorySource } from "@my-money/shared";

interface StagedRow extends DedupedRow {
  category_id: number | null;
  category_source: CategorySource | null;
}

interface StagedImport {
  accountId: number;
  fileName: string;
  fileSha256: string;
  fileBuffer: Buffer;
  spec: ImportSpec;
  specSource: "cache" | "ai" | "manual";
  formatFp: string;
  rows: StagedRow[];
  createdAt: number;
}

const staging = new Map<string, StagedImport>();
const STAGING_TTL_MS = 30 * 60 * 1000;

function gcStaging(): void {
  const now = Date.now();
  for (const [k, v] of staging) if (now - v.createdAt > STAGING_TTL_MS) staging.delete(k);
}

function lookupCachedSpec(formatFp: string): { id: number; spec: ImportSpec } | null {
  const row = db.prepare("SELECT id, spec_json FROM import_specs WHERE format_fingerprint = ?").get(formatFp) as
    | { id: number; spec_json: string }
    | undefined;
  if (!row) return null;
  const parsed = ImportSpecSchema.safeParse(JSON.parse(row.spec_json));
  if (!parsed.success) return null;
  return { id: row.id, spec: parsed.data };
}

function saveSpec(formatFp: string, spec: ImportSpec, source: "ai" | "user"): number {
  const existing = db.prepare("SELECT id FROM import_specs WHERE format_fingerprint = ?").get(formatFp) as
    | { id: number }
    | undefined;
  if (existing) {
    db.prepare(
      "UPDATE import_specs SET spec_json = ?, source = ?, bank_guess = ?, use_count = use_count + 1, last_used_at = unixepoch() WHERE id = ?"
    ).run(JSON.stringify(spec), source, spec.bank_guess, existing.id);
    return existing.id;
  }
  const info = db
    .prepare(
      "INSERT INTO import_specs (format_fingerprint, bank_guess, spec_json, source, use_count, last_used_at) VALUES (?, ?, ?, ?, 1, unixepoch())"
    )
    .run(formatFp, spec.bank_guess, JSON.stringify(spec), source);
  return Number(info.lastInsertRowid);
}

function touchSpec(id: number): void {
  db.prepare("UPDATE import_specs SET use_count = use_count + 1, last_used_at = unixepoch() WHERE id = ?").run(id);
}

interface StagePayload {
  token: string;
  result: object;
}

/** Shared tail of the pipeline: dedupe → categorize → stage → build AnalyzeResult. */
async function stageAppliedRows(opts: {
  accountId: number;
  fileName: string;
  sha: string;
  buf: Buffer;
  spec: ImportSpec;
  specSource: "cache" | "ai" | "manual";
  formatFp: string;
  applied: ReturnType<typeof applySpec>;
  previewRows: string[][];
  alreadyImported: boolean;
}): Promise<StagePayload> {
  const { accountId, applied } = opts;
  const account = db.prepare("SELECT kind FROM accounts WHERE id = ?").get(accountId) as
    | { kind: "asset" | "liability" }
    | undefined;
  const validation = validateApply(applied, account?.kind ?? "asset");
  const deduped = dedupeRows(accountId, applied.rows);

  const newRows = deduped.filter((r) => !r.duplicate);
  const catResults = categorizeByRules(newRows.map((r) => r.merchant_norm));
  const catNames = new Map(
    (db.prepare("SELECT id, name FROM categories").all() as { id: number; name: string }[]).map((r) => [r.id, r.name])
  );

  const stagedRows: StagedRow[] = deduped.map((r) => {
    const cat = r.duplicate ? undefined : catResults.get(r.merchant_norm);
    return { ...r, category_id: cat?.category_id ?? null, category_source: cat?.category_source ?? null };
  });

  const token = crypto.randomUUID();
  staging.set(token, {
    accountId,
    fileName: opts.fileName,
    fileSha256: opts.sha,
    fileBuffer: opts.buf,
    spec: opts.spec,
    specSource: opts.specSource,
    formatFp: opts.formatFp,
    rows: stagedRows,
    createdAt: Date.now(),
  });

  const rows: ParsedTxn[] = stagedRows.map((r) => ({
    row_index: r.row_index,
    posted_date: r.posted_date,
    description_raw: r.description_raw,
    merchant_norm: r.merchant_norm,
    amount_cents: r.amount_cents,
    fingerprint: r.fingerprint,
    duplicate: r.duplicate,
    category_id: r.category_id,
    category_source: r.category_source,
    category_name: r.category_id ? catNames.get(r.category_id) ?? null : null,
  }));

  return {
    token,
    result: {
      staging_token: token,
      file_name: opts.fileName,
      file_sha256: opts.sha,
      file_already_imported: opts.alreadyImported,
      spec: opts.spec,
      spec_source: opts.specSource,
      bank_guess: opts.spec.bank_guess,
      columns_preview: opts.previewRows.slice(0, 8),
      rows,
      new_count: rows.filter((r) => !r.duplicate).length,
      duplicate_count: rows.filter((r) => r.duplicate).length,
      parse_errors: applied.errors,
      validation,
    },
  };
}

async function stageFile(opts: {
  accountId: number;
  fileName: string;
  buf: Buffer;
  manualSpec?: ImportSpec;
}): Promise<{ token: string; result: object } | { error: string; status: 400 | 502; detail?: unknown }> {
  gcStaging();
  const { accountId, fileName, buf, manualSpec } = opts;
  const account = db.prepare("SELECT id FROM accounts WHERE id = ?").get(accountId);
  if (!account) return { error: "account not found", status: 400 };

  const { lines, text } = readCsvText(buf);
  if (lines.length === 0) return { error: "empty file", status: 400 };

  const sha = fileSha256(buf);
  const alreadyImported = !!db
    .prepare("SELECT id FROM imports WHERE account_id = ? AND file_sha256 = ? AND status = 'committed'")
    .get(accountId, sha);

  // Determine the spec: manual > cached (learned from a previous manual mapping
  // of the same format). Unknown formats go to the manual column-mapping editor —
  // or import via the MCP server, where the AI client does the parsing.
  const previewRows = parseRows(text, detectDelimiter(lines));
  const formatFp = formatFingerprint(previewRows);

  let spec: ImportSpec;
  let specSource: "cache" | "ai" | "manual";
  if (manualSpec) {
    spec = manualSpec;
    specSource = "manual";
  } else {
    const cached = lookupCachedSpec(formatFp);
    if (cached) {
      spec = cached.spec;
      specSource = "cache";
      touchSpec(cached.id);
      console.log(`[import] format cache HIT (${formatFp.slice(0, 24)}…)`);
    } else {
      return {
        error: "unknown format — map the columns manually below (or import via the MCP server)",
        status: 400,
        detail: { needs_manual_mapping: true, columns_preview: previewRows.slice(0, 8), format_fingerprint: formatFp },
      };
    }
  }

  const allRows = parseRows(text, spec.delimiter);
  const applied = applySpec(allRows, spec);

  return stageAppliedRows({
    accountId,
    fileName,
    sha,
    buf,
    spec,
    specSource,
    formatFp,
    applied,
    previewRows,
    alreadyImported,
  });
}

function detectDelimiter(lines: string[]): string {
  const sample = lines.slice(0, 5).join("\n");
  const counts: [string, number][] = [
    [",", (sample.match(/,/g) ?? []).length],
    [";", (sample.match(/;/g) ?? []).length],
    ["\t", (sample.match(/\t/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ",";
}

const ConfirmBody = z.object({
  staging_token: z.string(),
  excluded_row_indexes: z.array(z.number().int()).default([]),
  category_overrides: z.record(z.string(), z.number().int().nullable()).default({}),
  save_spec: z.boolean().default(true),
});

export const importsRoute = new Hono()
  .get("/", (c) => {
    const rows = db
      .prepare(
        `SELECT i.*, a.name AS account_name FROM imports i JOIN accounts a ON a.id = i.account_id ORDER BY i.created_at DESC`
      )
      .all();
    return c.json(rows);
  })
  .post("/analyze", async (c) => {
    const form = await c.req.formData();
    const file = form.get("file");
    const accountId = Number(form.get("account_id"));
    if (!(file instanceof File)) return c.json({ error: "file missing" }, 400);
    if (!accountId) return c.json({ error: "account_id missing" }, 400);
    const specJson = form.get("spec_json");
    let manualSpec: ImportSpec | undefined;
    if (typeof specJson === "string" && specJson) {
      const parsed = ImportSpecSchema.safeParse(JSON.parse(specJson));
      if (!parsed.success) return c.json({ error: "invalid spec_json", detail: parsed.error.issues }, 400);
      manualSpec = parsed.data;
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const out = await stageFile({ accountId, fileName: file.name, buf, manualSpec });
    if ("error" in out) return c.json({ error: out.error, ...(out.detail ? { detail: out.detail } : {}) }, out.status);
    return c.json(out.result);
  })
  .post("/confirm", async (c) => {
    const body = ConfirmBody.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: "bad body", detail: body.error.issues }, 400);
    const b = body.data;
    const staged = staging.get(b.staging_token);
    if (!staged) return c.json({ error: "staging token expired — re-run analyze" }, 410);

    const excluded = new Set(b.excluded_row_indexes);
    const toInsert = staged.rows.filter((r) => !r.duplicate && !excluded.has(r.row_index));

    let specId: number | null = null;
    if (b.save_spec && staged.specSource !== "cache") {
      specId = saveSpec(staged.formatFp, staged.spec, staged.specSource === "ai" ? "ai" : "user");
    } else {
      const cached = db
        .prepare("SELECT id FROM import_specs WHERE format_fingerprint = ?")
        .get(staged.formatFp) as { id: number } | undefined;
      specId = cached?.id ?? null;
    }

    const insertTxn = db.prepare(
      `INSERT OR IGNORE INTO transactions
       (account_id, posted_date, description_raw, merchant_norm, amount_cents, category_id, category_source, import_id, fingerprint)
       VALUES (@account_id, @posted_date, @description_raw, @merchant_norm, @amount_cents, @category_id, @category_source, @import_id, @fingerprint)`
    );
    const insertImport = db.prepare(
      `INSERT INTO imports (account_id, file_name, file_sha256, spec_id, row_count, inserted_count, skipped_dupes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'committed')`
    );

    const summary = tx(() => {
      const importInfo = insertImport.run(
        staged.accountId,
        staged.fileName,
        staged.fileSha256,
        specId,
        staged.rows.length,
        toInsert.length,
        staged.rows.filter((r) => r.duplicate).length
      );
      const importId = Number(importInfo.lastInsertRowid);
      let inserted = 0;
      for (const r of toInsert) {
        const override = b.category_overrides[String(r.row_index)];
        const categoryId = override !== undefined ? override : r.category_id;
        const source = override !== undefined ? "user" : r.category_source;
        const info = insertTxn.run({
          account_id: staged.accountId,
          posted_date: r.posted_date,
          description_raw: r.description_raw,
          merchant_norm: r.merchant_norm,
          amount_cents: r.amount_cents,
          category_id: categoryId,
          category_source: categoryId === null ? null : source,
          import_id: importId,
          fingerprint: r.fingerprint,
        });
        inserted += Number(info.changes);
      }
      db.prepare("UPDATE imports SET inserted_count = ? WHERE id = ?").run(inserted, importId);
      return { import_id: importId, inserted, skipped: staged.rows.length - inserted };
    });

    staging.delete(b.staging_token);
    return c.json(summary, 201);
  })
  .post("/:id/undo", (c) => {
    const id = Number(c.req.param("id"));
    const imp = db.prepare("SELECT * FROM imports WHERE id = ?").get(id) as { status: string } | undefined;
    if (!imp) return c.json({ error: "not found" }, 404);
    if (imp.status === "undone") return c.json({ error: "already undone" }, 400);
    const result = tx(() => {
      const del = db.prepare("DELETE FROM transactions WHERE import_id = ?").run(id);
      db.prepare("UPDATE imports SET status = 'undone' WHERE id = ?").run(id);
      return del.changes;
    });
    return c.json({ undone: true, deleted_transactions: result });
  });
