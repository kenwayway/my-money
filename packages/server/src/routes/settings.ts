import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db, tx } from "../db/connection.js";
import type { MerchantRule } from "@my-money/shared";

export const settingsRoute = new Hono()
  .get("/", (c) => {
    const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return c.json(settings);
  })
  .put("/", zValidator("json", z.record(z.string(), z.string())), (c) => {
    const body = c.req.valid("json");
    const upsert = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    tx(() => {
      for (const [k, v] of Object.entries(body)) upsert.run(k, v);
    });
    return c.json({ ok: true });
  });

export const fxRoute = new Hono()
  .get("/", (c) => c.json(db.prepare("SELECT * FROM fx_rates ORDER BY currency").all()))
  .put(
    "/",
    zValidator("json", z.object({ rates: z.array(z.object({ currency: z.string().length(3), rate_to_cad: z.number().positive() })) })),
    (c) => {
      const { rates } = c.req.valid("json");
      const upsert = db.prepare(
        "INSERT INTO fx_rates (currency, rate_to_cad, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(currency) DO UPDATE SET rate_to_cad = excluded.rate_to_cad, updated_at = unixepoch()"
      );
      tx(() => {
        for (const r of rates) upsert.run(r.currency.toUpperCase(), r.rate_to_cad);
      });
      return c.json(db.prepare("SELECT * FROM fx_rates ORDER BY currency").all());
    }
  )
  .delete("/:currency", (c) => {
    db.prepare("DELETE FROM fx_rates WHERE currency = ?").run(c.req.param("currency").toUpperCase());
    return c.json({ deleted: true });
  });

export const rulesRoute = new Hono()
  .get("/", (c) => {
    const rows = db
      .prepare(
        `SELECT r.*, c.name AS category_name, c.color AS category_color
         FROM merchant_rules r JOIN categories c ON c.id = r.category_id
         ORDER BY r.created_at DESC`
      )
      .all() as unknown as (MerchantRule & { category_name: string })[];
    return c.json(rows);
  })
  .delete("/:id", (c) => {
    db.prepare("DELETE FROM merchant_rules WHERE id = ?").run(Number(c.req.param("id")));
    return c.json({ deleted: true });
  });
