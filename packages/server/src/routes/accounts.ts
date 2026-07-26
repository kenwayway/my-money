import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/connection.js";
import { withBalance } from "../services/balances.js";
import type { Account } from "@my-money/shared";

const AccountBody = z.object({
  name: z.string().min(1),
  institution: z.string().nullable().optional(),
  type: z.enum(["chequing", "savings", "credit", "prepaid", "cash", "investment"]),
  currency: z.string().length(3).default("CAD"),
  last4: z.string().max(4).nullable().optional(),
  opening_balance_cents: z.number().int().default(0),
  opening_balance_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  color: z.string().default("#6366f1"),
  icon: z.string().default("credit-card"),
});

function kindFor(type: string): "asset" | "liability" {
  return type === "credit" ? "liability" : "asset";
}

export const accountsRoute = new Hono()
  .get("/", (c) => {
    const includeArchived = c.req.query("archived") === "1";
    const rows = db
      .prepare(`SELECT * FROM accounts ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY created_at`)
      .all() as unknown as Account[];
    return c.json(rows.map(withBalance));
  })
  .post("/", zValidator("json", AccountBody), (c) => {
    const b = c.req.valid("json");
    const info = db
      .prepare(
        `INSERT INTO accounts (name, institution, type, kind, currency, last4, opening_balance_cents, opening_balance_date, color, icon)
         VALUES (@name, @institution, @type, @kind, @currency, @last4, @opening_balance_cents, @opening_balance_date, @color, @icon)`
      )
      .run({
        name: b.name,
        institution: b.institution ?? null,
        type: b.type,
        kind: kindFor(b.type),
        currency: b.currency.toUpperCase(),
        last4: b.last4 ?? null,
        opening_balance_cents: b.opening_balance_cents,
        opening_balance_date: b.opening_balance_date ?? null,
        color: b.color,
        icon: b.icon,
      });
    const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(info.lastInsertRowid) as unknown as Account;
    return c.json(withBalance(row), 201);
  })
  .patch("/:id", zValidator("json", AccountBody.partial().extend({ archived: z.number().int().min(0).max(1).optional() })), (c) => {
    const id = Number(c.req.param("id"));
    const existing = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as unknown as Account | undefined;
    if (!existing) return c.json({ error: "not found" }, 404);
    const b = c.req.valid("json");
    const next = {
      ...existing,
      ...b,
      institution: b.institution === undefined ? existing.institution : b.institution,
      last4: b.last4 === undefined ? existing.last4 : b.last4,
      opening_balance_date: b.opening_balance_date === undefined ? existing.opening_balance_date : b.opening_balance_date,
      currency: b.currency ? b.currency.toUpperCase() : existing.currency,
      kind: b.type ? kindFor(b.type) : existing.kind,
    };
    db.prepare(
      `UPDATE accounts SET name=@name, institution=@institution, type=@type, kind=@kind, currency=@currency,
       last4=@last4, opening_balance_cents=@opening_balance_cents, opening_balance_date=@opening_balance_date,
       color=@color, icon=@icon, archived=@archived WHERE id=@id`
    ).run({
      name: next.name,
      institution: next.institution,
      type: next.type,
      kind: next.kind,
      currency: next.currency,
      last4: next.last4,
      opening_balance_cents: next.opening_balance_cents,
      opening_balance_date: next.opening_balance_date,
      color: next.color,
      icon: next.icon,
      archived: next.archived,
      id,
    });
    const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as unknown as Account;
    return c.json(withBalance(row));
  })
  .delete("/:id", (c) => {
    const id = Number(c.req.param("id"));
    const txnCount = (
      db.prepare("SELECT COUNT(*) AS c FROM transactions WHERE account_id = ?").get(id) as { c: number }
    ).c;
    if (txnCount > 0) {
      // safer default: archive instead of destroying history
      db.prepare("UPDATE accounts SET archived = 1 WHERE id = ?").run(id);
      return c.json({ archived: true, reason: `account has ${txnCount} transactions` });
    }
    db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
    return c.json({ deleted: true });
  })
  .get("/:id/snapshots", (c) => {
    const id = Number(c.req.param("id"));
    const rows = db
      .prepare("SELECT * FROM balance_snapshots WHERE account_id = ? ORDER BY snapshot_date DESC LIMIT 60")
      .all(id);
    return c.json(rows);
  })
  .post(
    "/:id/snapshots",
    zValidator(
      "json",
      z.object({
        snapshot_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        balance_cents: z.number().int(),
        note: z.string().nullable().optional(),
      })
    ),
    (c) => {
      const id = Number(c.req.param("id"));
      const account = db.prepare("SELECT id FROM accounts WHERE id = ?").get(id);
      if (!account) return c.json({ error: "account not found" }, 404);
      const b = c.req.valid("json");
      db.prepare(
        `INSERT INTO balance_snapshots (account_id, snapshot_date, balance_cents, note) VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id, snapshot_date) DO UPDATE SET balance_cents = excluded.balance_cents, note = excluded.note`
      ).run(id, b.snapshot_date, b.balance_cents, b.note ?? null);
      const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as unknown as Account;
      return c.json(withBalance(row), 201);
    }
  )
  .delete("/:id/snapshots/:date", (c) => {
    db.prepare("DELETE FROM balance_snapshots WHERE account_id = ? AND snapshot_date = ?").run(
      Number(c.req.param("id")),
      c.req.param("date")
    );
    return c.json({ deleted: true });
  });
