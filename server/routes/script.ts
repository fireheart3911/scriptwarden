import type { Hono } from "hono";
import { db } from "../db";
import { lineProduction, notifyDataChanged } from "./notify";
import { adminOf, allowedNoteCols, crewFromToken, deny } from "../auth";

const LINE_TYPES = new Set(["act", "scene", "character", "dialogue", "stage_dir", "song", "pause"]);

interface IncomingLine {
  type?: string;
  speaker?: string;
  text?: string;
  note?: string;
  color_override?: string | null;
}
interface IncomingCharacter {
  name: string;
  color?: string;
}

export function registerScript(app: Hono): void {
  // Replace the entire script for a production (used by the paste-import flow).
  // Also upserts characters so auto-colors survive re-import.
  app.post("/api/productions/:id/script", async (c) => {
    const id = Number(c.req.param("id"));
    if (!adminOf(c, id)) return deny(c);
    const body = await c.req.json().catch(() => ({}));
    const lines: IncomingLine[] = Array.isArray(body?.lines) ? body.lines : [];
    const characters: IncomingCharacter[] = Array.isArray(body?.characters) ? body.characters : [];

    const replace = db.transaction(() => {
      db.query("DELETE FROM script_lines WHERE production_id = ?").run(id);
      const insLine = db.query(
        `INSERT INTO script_lines (production_id, seq, type, speaker, text, note, color_override)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      lines.forEach((l, i) => {
        const type = LINE_TYPES.has(String(l.type)) ? String(l.type) : "dialogue";
        insLine.run(
          id,
          i,
          type,
          String(l.speaker ?? ""),
          String(l.text ?? ""),
          String(l.note ?? ""),
          l.color_override ?? null,
        );
      });
      const upsertChar = db.query(
        `INSERT INTO characters (production_id, name, color) VALUES (?, ?, ?)
         ON CONFLICT(production_id, name) DO UPDATE SET color = excluded.color`,
      );
      for (const ch of characters) {
        if (ch?.name) upsertChar.run(id, String(ch.name), String(ch.color ?? "#888888"));
      }
    });
    replace();
    notifyDataChanged(id, "script");

    const outLines = db
      .query("SELECT * FROM script_lines WHERE production_id = ? ORDER BY seq, id")
      .all(id);
    return c.json({ ok: true, lines: outLines });
  });

  // Append a single blank/typed line at the end.
  app.post("/api/productions/:id/lines", async (c) => {
    const id = Number(c.req.param("id"));
    if (!adminOf(c, id)) return deny(c);
    const body = await c.req.json().catch(() => ({}));
    const next =
      (db.query("SELECT COALESCE(MAX(seq), -1) AS m FROM script_lines WHERE production_id = ?").get(
        id,
      ) as { m: number }).m + 1;
    const type = LINE_TYPES.has(String(body?.type)) ? String(body.type) : "dialogue";
    const row = db
      .query(
        `INSERT INTO script_lines (production_id, seq, type, speaker, text)
         VALUES (?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(id, next, type, String(body?.speaker ?? ""), String(body?.text ?? ""));
    notifyDataChanged(id, "script");
    return c.json(row, 201);
  });

  app.patch("/api/lines/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await c.req.json().catch(() => ({}));
    // Admin edits anything; other crew may only touch their role's note column.
    const u = crewFromToken(c);
    if (!u || u.production_id !== lineProduction(id)) return deny(c);
    if (!u.is_admin) {
      const allowed = allowedNoteCols(u);
      if (Object.keys(body).some((k) => !allowed.has(k))) return deny(c);
    }
    const sets: string[] = [];
    const vals: unknown[] = [];
    const push = (col: string, val: unknown) => {
      sets.push(`${col} = ?`);
      vals.push(val);
    };
    if ("type" in body && LINE_TYPES.has(String(body.type))) push("type", String(body.type));
    if ("speaker" in body) push("speaker", String(body.speaker));
    if ("text" in body) push("text", String(body.text));
    if ("note" in body) push("note", String(body.note));
    if ("note_audio" in body) push("note_audio", String(body.note_audio));
    if ("color_override" in body) push("color_override", body.color_override ?? null);
    if ("seq" in body) push("seq", Number(body.seq));
    if (!sets.length) return c.json(db.query("SELECT * FROM script_lines WHERE id = ?").get(id));
    vals.push(id);
    const row = db
      .query(`UPDATE script_lines SET ${sets.join(", ")} WHERE id = ? RETURNING *`)
      .get(...(vals as never[]));
    notifyDataChanged((row as { production_id?: number })?.production_id, "script");
    return c.json(row);
  });

  app.delete("/api/lines/:id", (c) => {
    const lineId = Number(c.req.param("id"));
    const pid = lineProduction(lineId);
    if (!adminOf(c, pid)) return deny(c);
    db.query("DELETE FROM script_lines WHERE id = ?").run(lineId);
    notifyDataChanged(pid, "script");
    return c.json({ ok: true });
  });

  // Persist a new ordering: body { orderedIds: number[] }.
  app.post("/api/productions/:id/lines/reorder", async (c) => {
    const id = Number(c.req.param("id"));
    if (!adminOf(c, id)) return deny(c);
    const body = await c.req.json().catch(() => ({}));
    const ids: number[] = Array.isArray(body?.orderedIds) ? body.orderedIds.map(Number) : [];
    const upd = db.query("UPDATE script_lines SET seq = ? WHERE id = ?");
    db.transaction(() => ids.forEach((lineId, i) => upd.run(i, lineId)))();
    notifyDataChanged(id, "script");
    return c.json({ ok: true });
  });
}
