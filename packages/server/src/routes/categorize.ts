import { Hono } from "hono";
import { db, tx } from "../db/connection.js";
import { categorizeByRules } from "../services/categorizer.js";

/** Apply learned merchant rules to all uncategorized transactions (local only). */
export const categorizeRoute = new Hono().post("/run", (c) => {
  const uncategorized = db
    .prepare("SELECT id, merchant_norm FROM transactions WHERE category_id IS NULL AND is_transfer = 0")
    .all() as { id: number; merchant_norm: string }[];

  if (uncategorized.length === 0) return c.json({ updated: 0, remaining: 0 });

  const results = categorizeByRules(uncategorized.map((t) => t.merchant_norm));

  const update = db.prepare("UPDATE transactions SET category_id = ?, category_source = 'rule' WHERE id = ?");
  let updated = 0;
  tx(() => {
    for (const t of uncategorized) {
      const r = results.get(t.merchant_norm);
      if (r?.category_id != null) {
        update.run(r.category_id, t.id);
        updated++;
      }
    }
  });

  return c.json({ updated, remaining: uncategorized.length - updated });
});
