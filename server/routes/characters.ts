import type { Hono } from "hono";
import { db } from "../db";
import { characterProduction, notifyDataChanged } from "./notify";
import { adminOf, deny } from "../auth";

// Characters are script structure — admin-only, like the line routes.
export function registerCharacters(app: Hono): void {
  app.post("/api/productions/:id/characters", async (c) => {
    const id = Number(c.req.param("id"));
    if (!adminOf(c, id)) return deny(c);
    const body = await c.req.json().catch(() => ({}));
    const name = String(body?.name ?? "").trim();
    if (!name) return c.json({ error: "name required" }, 400);
    const row = db
      .query(
        `INSERT INTO characters (production_id, name, color) VALUES (?, ?, ?)
         ON CONFLICT(production_id, name) DO UPDATE SET color = excluded.color
         RETURNING *`,
      )
      .get(id, name, String(body?.color ?? "#888888"));
    notifyDataChanged(id, "script");
    return c.json(row, 201);
  });

  app.patch("/api/characters/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!adminOf(c, characterProduction(id))) return deny(c);
    const body = await c.req.json().catch(() => ({}));
    const sets: string[] = [];
    const vals: unknown[] = [];
    if ("name" in body) {
      sets.push("name = ?");
      vals.push(String(body.name));
    }
    if ("color" in body) {
      sets.push("color = ?");
      vals.push(String(body.color));
    }
    if (!sets.length) return c.json(db.query("SELECT * FROM characters WHERE id = ?").get(id));
    vals.push(id);
    const row = db
      .query(`UPDATE characters SET ${sets.join(", ")} WHERE id = ? RETURNING *`)
      .get(...(vals as never[]));
    notifyDataChanged((row as { production_id?: number })?.production_id, "script");
    return c.json(row);
  });

  app.delete("/api/characters/:id", (c) => {
    const charId = Number(c.req.param("id"));
    const pid = characterProduction(charId);
    if (!adminOf(c, pid)) return deny(c);
    db.query("DELETE FROM characters WHERE id = ?").run(charId);
    notifyDataChanged(pid, "script");
    return c.json({ ok: true });
  });
}
