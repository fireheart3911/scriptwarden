import type { Hono } from "hono";
import { db } from "../db";
import { notifyDataChanged } from "./notify";
import { adminFromToken } from "./session";
import { syncEosMonitor } from "../eosSync";

// Console connections (Ion/Eos OSC, Avantis MIDI) and the session join PIN are
// admin-only: patching any of these requires the X-Token of an admin of this
// production. Everything else (name, notes, smart settings) stays LAN-open.
const ADMIN_FIELDS = new Set([
  "osc_ip",
  "osc_port",
  "osc_protocol",
  "osc_enabled",
  "avantis_ip",
  "avantis_port",
  "avantis_channel",
  "avantis_enabled",
  "join_pin",
]);

// Coerce/whitelist patchable production fields to avoid boolean-bind errors and
// stray columns.
function coerceProductionPatch(body: Record<string, unknown>): [string[], unknown[]] {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const push = (col: string, val: unknown) => {
    sets.push(`${col} = ?`);
    vals.push(val);
  };
  if ("name" in body) push("name", String(body.name));
  if ("osc_ip" in body) push("osc_ip", String(body.osc_ip));
  if ("osc_port" in body) push("osc_port", Number(body.osc_port) || 8000);
  if ("osc_protocol" in body) push("osc_protocol", body.osc_protocol === "tcp" ? "tcp" : "udp");
  if ("osc_enabled" in body) push("osc_enabled", body.osc_enabled ? 1 : 0);
  if ("notes" in body) push("notes", String(body.notes));
  // v2: Avantis (audio console) config + join PIN. Harmless additive plumbing —
  // the Settings UI for these arrives in later milestones (§2, §7).
  if ("avantis_ip" in body) push("avantis_ip", String(body.avantis_ip));
  if ("avantis_port" in body) push("avantis_port", Number(body.avantis_port) || 51325);
  if ("avantis_channel" in body) {
    const ch = Math.trunc(Number(body.avantis_channel) || 1);
    push("avantis_channel", Math.min(16, Math.max(1, ch)));
  }
  if ("avantis_enabled" in body) push("avantis_enabled", body.avantis_enabled ? 1 : 0);
  if ("join_pin" in body) push("join_pin", String(body.join_pin));
  // settings: a JSON blob of Show Mode smart settings. Accept an object (stored
  // stringified) or a string that already parses to a plain object; ignore
  // anything else (arrays, primitives, malformed JSON) rather than corrupt it.
  if ("settings" in body) {
    const parsed = coerceSettings(body.settings);
    if (parsed !== undefined) push("settings", parsed);
  }
  return [sets, vals];
}

// Normalize a settings patch value to a JSON object string, or undefined to skip.
function coerceSettings(value: unknown): string | undefined {
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (isPlainObject(value)) return JSON.stringify(value);
  if (typeof value === "string") {
    try {
      const obj = JSON.parse(value);
      if (isPlainObject(obj)) return JSON.stringify(obj);
    } catch {
      /* malformed JSON — reject */
    }
  }
  return undefined;
}

export function registerProductions(app: Hono): void {
  app.get("/api/productions", (c) =>
    c.json(db.query("SELECT * FROM productions ORDER BY created_at DESC, id DESC").all()),
  );

  app.post("/api/productions", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = String(body?.name ?? "Untitled Production");
    const row = db.query("INSERT INTO productions (name) VALUES (?) RETURNING *").get(name);
    return c.json(row, 201);
  });

  // Everything the editor needs for one production in a single request.
  app.get("/api/productions/:id/bundle", (c) => {
    const id = Number(c.req.param("id"));
    const production = db.query("SELECT * FROM productions WHERE id = ?").get(id);
    if (!production) return c.json({ error: "not found" }, 404);

    const characters = db
      .query("SELECT * FROM characters WHERE production_id = ? ORDER BY name")
      .all(id);
    const lines = db
      .query("SELECT * FROM script_lines WHERE production_id = ? ORDER BY seq, id")
      .all(id) as { id: number }[];
    const lineIds = lines.map((l) => l.id);
    const sections = lineIds.length
      ? db
          .query(
            `SELECT * FROM song_sections WHERE song_line_id IN (${lineIds
              .map(() => "?")
              .join(",")}) ORDER BY seq, id`,
          )
          .all(...lineIds)
      : [];
    const cues = db.query("SELECT * FROM cues WHERE production_id = ? ORDER BY id").all(id);
    return c.json({ production, characters, lines, sections, cues });
  });

  // Full show as a downloadable JSON envelope (production + all its data).
  // Uses the same queries as /bundle; sections are scoped to this production's
  // song lines.
  app.get("/api/productions/:id/export", (c) => {
    const id = Number(c.req.param("id"));
    const production = db.query("SELECT * FROM productions WHERE id = ?").get(id) as
      | { name?: unknown }
      | undefined;
    if (!production) return c.json({ error: "not found" }, 404);

    const characters = db
      .query("SELECT * FROM characters WHERE production_id = ? ORDER BY name")
      .all(id);
    const lines = db
      .query("SELECT * FROM script_lines WHERE production_id = ? ORDER BY seq, id")
      .all(id) as { id: number }[];
    const lineIds = lines.map((l) => l.id);
    const sections = lineIds.length
      ? db
          .query(
            `SELECT * FROM song_sections WHERE song_line_id IN (${lineIds
              .map(() => "?")
              .join(",")}) ORDER BY seq, id`,
          )
          .all(...lineIds)
      : [];
    const cues = db.query("SELECT * FROM cues WHERE production_id = ? ORDER BY id").all(id);

    // Sanitize the production name into a safe filename. Strip to [a-z0-9-_],
    // which also guards against header injection (no CR/LF/quotes survive).
    const rawName = typeof production.name === "string" ? production.name : "";
    const safeName =
      rawName
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, "-")
        .replace(/^-+|-+$/g, "") || "show";

    return c.json(
      { format: "scriptwarden-export", version: 1, production, characters, lines, sections, cues },
      200,
      {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${safeName}.scriptwarden.json"`,
      },
    );
  });

  app.patch("/api/productions/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await c.req.json().catch(() => ({}));
    if (Object.keys(body).some((k) => ADMIN_FIELDS.has(k))) {
      const admin = adminFromToken(c);
      if (!admin || admin.production_id !== id) {
        return c.json({ error: "admin_required" }, 403);
      }
    }
    const [sets, vals] = coerceProductionPatch(body);
    if (!sets.length) {
      return c.json(db.query("SELECT * FROM productions WHERE id = ?").get(id));
    }
    vals.push(id);
    const row = db
      .query(`UPDATE productions SET ${sets.join(", ")} WHERE id = ? RETURNING *`)
      .get(...(vals as never[]));
    notifyDataChanged(id, "production");
    // Console config may have changed — (re)point the Eos cue monitor.
    syncEosMonitor(id);
    return c.json(row);
  });

  // Admin-only: deleting a whole production is the sharpest tool in the box.
  app.delete("/api/productions/:id", (c) => {
    const id = Number(c.req.param("id"));
    const admin = adminFromToken(c);
    if (!admin || admin.production_id !== id) {
      return c.json({ error: "admin_required" }, 403);
    }
    db.query("DELETE FROM productions WHERE id = ?").run(id);
    return c.json({ ok: true });
  });
}
