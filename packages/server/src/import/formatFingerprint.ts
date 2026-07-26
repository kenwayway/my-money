import crypto from "node:crypto";

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function looksLikeDate(cell: string): boolean {
  return /^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/.test(cell.trim());
}

function looksLikeMoney(cell: string): boolean {
  return /^-?\(?\$?-?[\d, ]*\d\.\d{2}\)?$/.test(cell.trim());
}

function looksLikeNumber(cell: string): boolean {
  return /^-?[\d, ]+\.?\d*$/.test(cell.trim()) && cell.trim() !== "";
}

function typeTag(cell: string): string {
  const t = cell.trim();
  if (t === "") return "empty";
  if (looksLikeDate(t)) return "date";
  if (looksLikeMoney(t)) return "money";
  if (looksLikeNumber(t)) return "num";
  return "text";
}

/** Does the first line look like a header (mostly non-numeric labels)? */
export function guessHasHeader(rows: string[][]): boolean {
  const first = rows[0];
  if (!first) return false;
  const labelish = first.filter((c) => typeTag(c) === "text").length;
  return labelish >= Math.max(1, Math.ceil(first.length / 2));
}

/**
 * Stable fingerprint for a CSV format, used as the import_specs cache key.
 * Header present → hash of normalized header row.
 * Headerless → shape signature from column count + per-column type tags.
 */
export function formatFingerprint(rows: string[][]): string {
  const first = rows[0];
  if (!first) return "empty";
  if (guessHasHeader(rows)) {
    const norm = first.map((c) => c.trim().toLowerCase().replace(/\s+/g, " ")).join("|");
    return "header:" + sha256(norm);
  }
  // sample a few data rows and take the dominant tag per column
  const sample = rows.slice(0, 5);
  const cols = first.length;
  const tags: string[] = [];
  for (let c = 0; c < cols; c++) {
    const counts = new Map<string, number>();
    for (const row of sample) {
      const tag = typeTag(row[c] ?? "");
      if (tag === "empty") continue;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    let best = "text";
    let bestCount = -1;
    for (const [tag, n] of counts) {
      if (n > bestCount) {
        best = tag;
        bestCount = n;
      }
    }
    tags.push(best);
  }
  return `noheader:${cols}:${tags.join(",")}`;
}

export function fileSha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
