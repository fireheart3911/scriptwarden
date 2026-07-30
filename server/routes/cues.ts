import type { Hono } from "hono";
import { db } from "../db";
import { cueProduction, notifyDataChanged } from "./notify";
import { crewFromToken, deny, mayEditCue } from "../auth";

const FIRE_MODES = new Set(["fire", "go", "cmd"]);
const DEPARTMENTS = new Set(["lights", "audio", "spot"]);

// Cue editing is role-scoped: the admin manages any department (incl. spot);
// lights/audio operators manage exactly their own department's cues.
export function registerCues(app: Hono): void {
  app.post("/api/productions/:id/cues", async (c) => {
    const id = Number(c.req.param("id"));
    const b = await c.req.json().catch(() => ({}));
    const anchorType = b?.anchor_type === "section" ? "section" : "line";
    const fireMode = FIRE_MODES.has(String(b?.fire_mode)) ? String(b.fire_mode) : "fire";
    const department = DEPARTMENTS.has(String(b?.department)) ? String(b.department) : "lights";
    const u = crewFromToken(c);
    if (!u || u.production_id !== id || !mayEditCue(u, department)) return deny(c);
    const row = db
      .query(
        `INSERT INTO cues
           (production_id, anchor_type, anchor_id, cue_list, cue_number, label, notes, fire_mode, cmd_text,
            department, spot_target, avantis_scene, spot_pickup, spot_color, spot_size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        id,
        anchorType,
        Number(b?.anchor_id) || 0,
        Number(b?.cue_list) || 1,
        String(b?.cue_number ?? ""),
        String(b?.label ?? ""),
        String(b?.notes ?? ""),
        fireMode,
        String(b?.cmd_text ?? ""),
        department,
        Number(b?.spot_target) || 0,
        Number(b?.avantis_scene) || 0,
        String(b?.spot_pickup ?? ""),
        String(b?.spot_color ?? ""),
        String(b?.spot_size ?? ""),
      );
    notifyDataChanged(id, "cues");
    return c.json(row, 201);
  });

  app.patch("/api/cues/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const b = await c.req.json().catch(() => ({}));
    const existing = db.query("SELECT production_id, department FROM cues WHERE id = ?").get(id) as
      | { production_id: number; department: string }
      | null;
    if (!existing) return c.json({ error: "not_found" }, 404);
    const u = crewFromToken(c);
    // Must be allowed on the cue's CURRENT department, and (for operators) any
    // department change must stay inside their own department.
    if (
      !u ||
      u.production_id !== existing.production_id ||
      !mayEditCue(u, existing.department) ||
      ("department" in b && !mayEditCue(u, String(b.department)))
    ) {
      return deny(c);
    }
    const sets: string[] = [];
    const vals: unknown[] = [];
    const push = (col: string, val: unknown) => {
      sets.push(`${col} = ?`);
      vals.push(val);
    };
    if ("cue_list" in b) push("cue_list", Number(b.cue_list) || 1);
    if ("cue_number" in b) push("cue_number", String(b.cue_number));
    if ("label" in b) push("label", String(b.label));
    if ("notes" in b) push("notes", String(b.notes));
    if ("fire_mode" in b && FIRE_MODES.has(String(b.fire_mode))) push("fire_mode", String(b.fire_mode));
    if ("cmd_text" in b) push("cmd_text", String(b.cmd_text));
    if ("anchor_type" in b) push("anchor_type", b.anchor_type === "section" ? "section" : "line");
    if ("anchor_id" in b) push("anchor_id", Number(b.anchor_id) || 0);
    // v2 department model (harmless additive columns; editor UI arrives in M2).
    if ("department" in b && DEPARTMENTS.has(String(b.department))) push("department", String(b.department));
    if ("spot_target" in b) push("spot_target", Number(b.spot_target) || 0);
    if ("avantis_scene" in b) push("avantis_scene", Number(b.avantis_scene) || 0);
    if ("spot_pickup" in b) push("spot_pickup", String(b.spot_pickup));
    if ("spot_color" in b) push("spot_color", String(b.spot_color));
    if ("spot_size" in b) push("spot_size", String(b.spot_size));
    if (!sets.length) return c.json(db.query("SELECT * FROM cues WHERE id = ?").get(id));
    vals.push(id);
    const row = db
      .query(`UPDATE cues SET ${sets.join(", ")} WHERE id = ? RETURNING *`)
      .get(...(vals as never[]));
    notifyDataChanged((row as { production_id?: number })?.production_id, "cues");
    return c.json(row);
  });

  app.delete("/api/cues/:id", (c) => {
    const cueId = Number(c.req.param("id"));
    const existing = db.query("SELECT production_id, department FROM cues WHERE id = ?").get(cueId) as
      | { production_id: number; department: string }
      | null;
    if (!existing) return c.json({ ok: true });
    const u = crewFromToken(c);
    if (!u || u.production_id !== existing.production_id || !mayEditCue(u, existing.department)) {
      return deny(c);
    }
    const pid = cueProduction(cueId);
    db.query("DELETE FROM cues WHERE id = ?").run(cueId);
    notifyDataChanged(pid, "cues");
    return c.json({ ok: true });
  });
}
