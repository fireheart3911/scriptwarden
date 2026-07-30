import type { Hono } from "hono";
import { db } from "../db";
import { lineProduction, notifyDataChanged, sectionProduction } from "./notify";
import { adminOf, allowedNoteCols, crewFromToken, deny } from "../auth";

// Song sections are the ordered inner structure of a 'song' line.
export function registerSongs(app: Hono): void {
  app.post("/api/lines/:lineId/sections", async (c) => {
    const lineId = Number(c.req.param("lineId"));
    if (!adminOf(c, lineProduction(lineId))) return deny(c);
    const body = await c.req.json().catch(() => ({}));
    const next =
      (db
        .query("SELECT COALESCE(MAX(seq), -1) AS m FROM song_sections WHERE song_line_id = ?")
        .get(lineId) as { m: number }).m + 1;
    const row = db
      .query(
        `INSERT INTO song_sections (song_line_id, seq, label, note, lyrics, loop) VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        lineId,
        next,
        String(body?.label ?? "Section"),
        String(body?.note ?? ""),
        String(body?.lyrics ?? ""),
        body?.loop ? 1 : 0,
      );
    notifyDataChanged(lineProduction(lineId), "script");
    return c.json(row, 201);
  });

  app.patch("/api/sections/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await c.req.json().catch(() => ({}));
    // Admin edits anything; other crew may only touch their role's note column.
    const u = crewFromToken(c);
    if (!u || u.production_id !== sectionProduction(id)) return deny(c);
    if (!u.is_admin) {
      const allowed = allowedNoteCols(u);
      if (Object.keys(body).some((k) => !allowed.has(k))) return deny(c);
    }
    const sets: string[] = [];
    const vals: unknown[] = [];
    if ("label" in body) {
      sets.push("label = ?");
      vals.push(String(body.label));
    }
    if ("note" in body) {
      sets.push("note = ?");
      vals.push(String(body.note));
    }
    if ("note_audio" in body) {
      sets.push("note_audio = ?");
      vals.push(String(body.note_audio));
    }
    if ("lyrics" in body) {
      sets.push("lyrics = ?");
      vals.push(String(body.lyrics));
    }
    if ("loop" in body) {
      sets.push("loop = ?");
      vals.push(body.loop ? 1 : 0);
    }
    if ("seq" in body) {
      sets.push("seq = ?");
      vals.push(Number(body.seq));
    }
    if (!sets.length) return c.json(db.query("SELECT * FROM song_sections WHERE id = ?").get(id));
    vals.push(id);
    const row = db
      .query(`UPDATE song_sections SET ${sets.join(", ")} WHERE id = ? RETURNING *`)
      .get(...(vals as never[]));
    notifyDataChanged(sectionProduction(id), "script");
    return c.json(row);
  });

  app.delete("/api/sections/:id", (c) => {
    const sectionId = Number(c.req.param("id"));
    const pid = sectionProduction(sectionId);
    if (!adminOf(c, pid)) return deny(c);
    db.query("DELETE FROM song_sections WHERE id = ?").run(sectionId);
    notifyDataChanged(pid, "script");
    return c.json({ ok: true });
  });

  app.post("/api/lines/:lineId/sections/reorder", async (c) => {
    const lineId = Number(c.req.param("lineId"));
    if (!adminOf(c, lineProduction(lineId))) return deny(c);
    const body = await c.req.json().catch(() => ({}));
    const ids: number[] = Array.isArray(body?.orderedIds) ? body.orderedIds.map(Number) : [];
    const upd = db.query("UPDATE song_sections SET seq = ? WHERE id = ?");
    db.transaction(() => ids.forEach((sid, i) => upd.run(i, sid)))();
    notifyDataChanged(lineProduction(lineId), "script");
    return c.json({ ok: true });
  });
}
