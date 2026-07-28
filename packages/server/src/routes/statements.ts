import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db, tx } from "../db/connection.js";
import {
  listStatements,
  reconcileStatement,
  statementDetail,
} from "../services/statements.js";

export const statementsRoute = new Hono()
  .get("/", (c) => c.json(listStatements()))
  .get("/:id", (c) => {
    const detail = statementDetail(Number(c.req.param("id")));
    return detail ? c.json(detail) : c.json({ error: "not found" }, 404);
  })
  .post(
    "/:id/reconcile",
    zValidator(
      "json",
      z.object({
        statement_end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        statement_balance_cents: z.number().int(),
      })
    ),
    (c) => {
      try {
        const body = c.req.valid("json");
        return c.json(
          reconcileStatement(
            Number(c.req.param("id")),
            body.statement_end_date,
            body.statement_balance_cents
          )
        );
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
  )
  .post("/:id/undo", (c) => {
    const id = Number(c.req.param("id"));
    const statement = db
      .prepare("SELECT status FROM imports WHERE id = ?")
      .get(id) as { status: string } | undefined;
    if (!statement) return c.json({ error: "not found" }, 404);
    if (statement.status === "undone") return c.json({ error: "already undone" }, 400);

    const deletedTransactions = tx(() => {
      const deleted = db.prepare("DELETE FROM transactions WHERE import_id = ?").run(id);
      db.prepare("UPDATE imports SET status = 'undone' WHERE id = ?").run(id);
      return deleted.changes;
    });
    return c.json({ undone: true, deleted_transactions: deletedTransactions });
  });
