import { Hono } from "hono";
import { db, tx } from "../db/connection.js";
import { categorizeByRules } from "../services/categorizer.js";
import { transferCategoryIds } from "../services/transfers.js";

/** Apply learned merchant rules to all uncategorized transactions (local only). */
export const categorizeRoute = new Hono().post("/run", (c) => {
  const uncategorized = db
    .prepare(
      `SELECT id, merchant_norm
       FROM transactions
       WHERE category_id IS NULL
         AND is_transfer = 0
         AND NOT (amount_cents > 0 AND refund_peer_id IS NOT NULL)`
    )
    .all() as { id: number; merchant_norm: string }[];

  if (uncategorized.length === 0) return c.json({ updated: 0, remaining: 0 });

  const results = categorizeByRules(uncategorized.map((t) => t.merchant_norm));

  const update = db.prepare("UPDATE transactions SET category_id = ?, category_source = 'rule' WHERE id = ?");
  // A learned rule can point at a transfer category (e.g. "BMO MASTERCARD
  // PAYMENT"); applying it has to set the flag too, or the two would disagree.
  const flagTransfer = db.prepare("UPDATE transactions SET is_transfer = 1 WHERE id = ?");
  const transferCats = transferCategoryIds();
  let updated = 0;
  tx(() => {
    for (const t of uncategorized) {
      const r = results.get(t.merchant_norm);
      if (r?.category_id != null) {
        update.run(r.category_id, t.id);
        if (transferCats.has(r.category_id)) flagTransfer.run(t.id);
        updated++;
      }
    }
  });

  return c.json({ updated, remaining: uncategorized.length - updated });
});
