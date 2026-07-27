import { db } from "../db/connection.js";
import type { MerchantRule } from "@my-money/shared";

/** Normalize a raw bank description into a stable merchant key for rule matching. */
export function normalizeMerchant(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[#*]\s*\d+/g, "") // store numbers: "TIM HORTONS #1234"
    .replace(/\b\d{4,}\b/g, "") // long digit runs (card refs, invoice ids)
    .replace(/[^A-Z0-9&'./ -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface RuleMatch {
  category_id: number;
  /** who created the winning rule — user rules outrank any AI suggestion */
  rule_source: "user" | "ai";
}

/** Look up merchant_rules for one normalized merchant. User rules beat AI rules; exact beats prefix beats contains. */
export function matchRule(merchantNorm: string): RuleMatch | null {
  const rules = db
    .prepare(
      `SELECT * FROM merchant_rules
       WHERE (match_type = 'exact' AND pattern = @m)
          OR (match_type = 'prefix' AND @m LIKE pattern || '%')
          OR (match_type = 'contains' AND instr(@m, pattern) > 0)
       ORDER BY CASE source WHEN 'user' THEN 0 ELSE 1 END,
                CASE match_type WHEN 'exact' THEN 0 WHEN 'prefix' THEN 1 ELSE 2 END,
                length(pattern) DESC
       LIMIT 1`
    )
    .all({ m: merchantNorm }) as unknown as MerchantRule[];
  const rule = rules[0];
  return rule ? { category_id: rule.category_id, rule_source: rule.source } : null;
}

/** Upsert an exact-match rule. An AI rule never overwrites a user rule. */
export function upsertRuleSafe(pattern: string, categoryId: number, source: "ai" | "user"): void {
  const existing = db
    .prepare("SELECT * FROM merchant_rules WHERE pattern = ? AND match_type = 'exact'")
    .get(pattern) as MerchantRule | undefined;
  if (existing) {
    if (existing.source === "user" && source === "ai") return; // user rules win
    db.prepare("UPDATE merchant_rules SET category_id = ?, source = ? WHERE id = ?").run(
      categoryId,
      source,
      existing.id
    );
  } else {
    db.prepare("INSERT INTO merchant_rules (pattern, match_type, category_id, source) VALUES (?, 'exact', ?, ?)").run(
      pattern,
      categoryId,
      source
    );
  }
}

export interface CategorizeOutcome {
  category_id: number | null;
  category_source: "rule" | null;
  rule_source: "user" | "ai" | null;
}

/**
 * Categorize merchants using local merchant_rules only. Intelligence lives in
 * the MCP client (the AI supplies categories when importing via MCP); this
 * function just applies what has been learned so far.
 */
export function categorizeByRules(merchantNorms: string[]): Map<string, CategorizeOutcome> {
  const results = new Map<string, CategorizeOutcome>();
  for (const m of new Set(merchantNorms)) {
    const rule = matchRule(m);
    results.set(
      m,
      rule
        ? { category_id: rule.category_id, category_source: "rule", rule_source: rule.rule_source }
        : { category_id: null, category_source: null, rule_source: null }
    );
  }
  return results;
}
