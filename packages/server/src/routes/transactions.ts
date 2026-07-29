import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db, tx } from "../db/connection.js";
import { upsertRuleSafe } from "../services/categorizer.js";
import { pairTransfer, unmarkTransferInTransaction } from "../services/transfers.js";
import {
  pairRefund,
  refundCandidates,
  unpairRefund,
  unpairRefundInTransaction,
} from "../services/refunds.js";
import type { Transaction } from "@my-money/shared";

const PatchBody = z.object({
  category_id: z.number().int().nullable().optional(),
  notes: z.string().nullable().optional(),
  is_transfer: z.number().int().min(0).max(1).optional(),
  /** when changing category: also apply to all other txns with the same merchant_norm */
  apply_to_same_merchant: z.boolean().default(false),
});

export const transactionsRoute = new Hono()
  .get("/", (c) => {
    const q = c.req.query();
    const cond: string[] = [];
    const params: Record<string, string | number> = {};
    if (q.account_id) {
      cond.push("t.account_id = @account_id");
      params.account_id = Number(q.account_id);
    }
    if (q.from) {
      cond.push("t.posted_date >= @from");
      params.from = q.from;
    }
    if (q.to) {
      cond.push("t.posted_date <= @to");
      params.to = q.to;
    }
    if (q.category_id) {
      cond.push("t.category_id = @category_id");
      params.category_id = Number(q.category_id);
    }
    if (q.uncategorized === "1") {
      cond.push("t.category_id IS NULL AND NOT (t.amount_cents > 0 AND t.refund_peer_id IS NOT NULL)");
    }
    if (q.q) {
      cond.push("(t.description_raw LIKE @search OR t.merchant_norm LIKE @search OR t.notes LIKE @search)");
      params.search = `%${q.q}%`;
    }
    const limit = Math.min(Number(q.limit ?? 100), 500);
    const offset = Number(q.offset ?? 0);
    const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
    const rows = db
      .prepare(
        `SELECT t.*, a.name AS account_name, a.currency AS account_currency,
                c.name AS category_name, c.color AS category_color, c.icon AS category_icon,
                refund_peer.amount_cents AS refund_peer_amount_cents,
                refund_peer.description_raw AS refund_peer_description,
                refund_peer.posted_date AS refund_peer_date
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id
         LEFT JOIN transactions refund_peer ON refund_peer.id = t.refund_peer_id
         ${where}
         ORDER BY t.posted_date DESC, t.id DESC
         LIMIT @limit OFFSET @offset`
      )
      .all({ ...params, limit, offset });
    const totalStmt = db.prepare(`SELECT COUNT(*) AS n FROM transactions t ${where}`);
    const total = ((cond.length ? totalStmt.get(params) : totalStmt.get()) as { n: number }).n;
    return c.json({ rows, total, limit, offset });
  })
  .patch("/:id", zValidator("json", PatchBody), (c) => {
    const id = Number(c.req.param("id"));
    const existing = db.prepare("SELECT * FROM transactions WHERE id = ?").get(id) as unknown as Transaction | undefined;
    if (!existing) return c.json({ error: "not found" }, 404);
    const b = c.req.valid("json");

    let sameMerchantUpdated = 0;
    tx(() => {
      if (b.category_id !== undefined) {
        db.prepare("UPDATE transactions SET category_id = ?, category_source = ? WHERE id = ?").run(
          b.category_id,
          b.category_id === null ? null : "user",
          id
        );
        if (b.category_id !== null) {
          upsertRuleSafe(existing.merchant_norm, b.category_id, "user");
          if (b.apply_to_same_merchant) {
            const info = db
              .prepare(
                `UPDATE transactions SET category_id = ?, category_source = 'user'
                 WHERE merchant_norm = ? AND id != ? AND (category_source IS NULL OR category_source != 'user')`
              )
              .run(b.category_id, existing.merchant_norm, id);
            sameMerchantUpdated = Number(info.changes);
          }
        }
      }
      if (b.notes !== undefined) db.prepare("UPDATE transactions SET notes = ? WHERE id = ?").run(b.notes, id);
      if (b.is_transfer !== undefined) {
        if (b.is_transfer === 1) {
          unpairRefundInTransaction(id);
          db.prepare("UPDATE transactions SET is_transfer = 1 WHERE id = ?").run(id);
        }
        else unmarkTransferInTransaction(id);
      }
    });

    const row = db.prepare("SELECT * FROM transactions WHERE id = ?").get(id);
    return c.json({ transaction: row, same_merchant_updated: sameMerchantUpdated });
  })
  .get("/:id/same-merchant-count", (c) => {
    const id = Number(c.req.param("id"));
    const existing = db.prepare("SELECT merchant_norm FROM transactions WHERE id = ?").get(id) as
      | { merchant_norm: string }
      | undefined;
    if (!existing) return c.json({ error: "not found" }, 404);
    const n = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM transactions
           WHERE merchant_norm = ? AND id != ? AND (category_source IS NULL OR category_source != 'user')`
        )
        .get(existing.merchant_norm, id) as { n: number }
    ).n;
    return c.json({ count: n, merchant_norm: existing.merchant_norm });
  })
  .get("/:id/refund-candidates", (c) => {
    try {
      return c.json(refundCandidates(Number(c.req.param("id"))));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  })
  .delete("/:id/refund-pair", (c) => {
    try {
      unpairRefund(Number(c.req.param("id")));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    return c.json({ unpaired: true });
  })
  .post(
    "/pair-refund",
    zValidator(
      "json",
      z.object({
        expense_id: z.number().int(),
        refund_id: z.number().int(),
      })
    ),
    (c) => {
      const { expense_id, refund_id } = c.req.valid("json");
      try {
        pairRefund(expense_id, refund_id);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
      return c.json({ paired: true });
    }
  )
  .post(
    "/pair-transfer",
    zValidator(
      "json",
      z.object({
        id_a: z.number().int(),
        id_b: z.number().int(),
        allow_mismatch: z.boolean().default(false),
      })
    ),
    (c) => {
      const { id_a, id_b, allow_mismatch } = c.req.valid("json");
      try {
        pairTransfer(id_a, id_b, allow_mismatch);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
      return c.json({ paired: true });
    }
  );
