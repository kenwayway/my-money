import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/connection.js";
import type { Category } from "@my-money/shared";

const CategoryBody = z.object({
  name: z.string().min(1),
  type: z.enum(["income", "expense", "transfer"]),
  color: z.string().default("#6366f1"),
  icon: z.string().default("tag"),
  sort_order: z.number().int().default(999),
});

export const categoriesRoute = new Hono()
  .get("/", (c) => {
    const rows = db.prepare("SELECT * FROM categories ORDER BY sort_order, name").all() as unknown as Category[];
    return c.json(rows);
  })
  .post("/", zValidator("json", CategoryBody), (c) => {
    const b = c.req.valid("json");
    try {
      const info = db
        .prepare("INSERT INTO categories (name, type, color, icon, sort_order) VALUES (?, ?, ?, ?, ?)")
        .run(b.name, b.type, b.color, b.icon, b.sort_order);
      return c.json(db.prepare("SELECT * FROM categories WHERE id = ?").get(info.lastInsertRowid), 201);
    } catch {
      return c.json({ error: "category name already exists" }, 409);
    }
  })
  .patch("/:id", zValidator("json", CategoryBody.partial()), (c) => {
    const id = Number(c.req.param("id"));
    const existing = db.prepare("SELECT * FROM categories WHERE id = ?").get(id) as unknown as Category | undefined;
    if (!existing) return c.json({ error: "not found" }, 404);
    const b = c.req.valid("json");
    // Renaming is safe — nothing matches categories by name. Retyping a system
    // category is not: flipping Transfer to 'expense' would silently pull every
    // internal money movement back into the spending totals.
    if (existing.is_system && b.type !== undefined && b.type !== existing.type) {
      return c.json({ error: "system category type cannot be changed" }, 400);
    }
    const next = { ...existing, ...b };
    db.prepare("UPDATE categories SET name=@name, type=@type, color=@color, icon=@icon, sort_order=@sort_order WHERE id=@id").run({
      name: next.name,
      type: next.type,
      color: next.color,
      icon: next.icon,
      sort_order: next.sort_order,
      id,
    });
    return c.json(db.prepare("SELECT * FROM categories WHERE id = ?").get(id));
  })
  .delete("/:id", (c) => {
    const id = Number(c.req.param("id"));
    const existing = db.prepare("SELECT * FROM categories WHERE id = ?").get(id) as unknown as Category | undefined;
    if (!existing) return c.json({ error: "not found" }, 404);
    if (existing.is_system) return c.json({ error: "system category cannot be deleted" }, 400);
    db.prepare("DELETE FROM categories WHERE id = ?").run(id);
    return c.json({ deleted: true });
  });
