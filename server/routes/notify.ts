// server/routes/notify.ts — after an editor mutation, invalidate the room's
// cached order and tell connected clients to refetch the bundle (§4.3, §1).

import { db } from "../db";
import { hub } from "../ws/hub";
import { rooms } from "../ws/room";
import type { S2C } from "../../shared/protocol";

type Scope = Extract<S2C, { type: "dataChanged" }>["scope"];

export function notifyDataChanged(productionId: number | null | undefined, scope: Scope): void {
  if (!productionId) return;
  rooms.invalidateOrder(productionId);
  hub.broadcast(productionId, { type: "dataChanged", scope });
}

// --- productionId resolvers (needed by patch/delete routes keyed by child id) ---

export function lineProduction(lineId: number): number | null {
  const r = db.query("SELECT production_id FROM script_lines WHERE id = ?").get(lineId) as
    | { production_id: number }
    | null;
  return r?.production_id ?? null;
}

export function cueProduction(cueId: number): number | null {
  const r = db.query("SELECT production_id FROM cues WHERE id = ?").get(cueId) as
    | { production_id: number }
    | null;
  return r?.production_id ?? null;
}

export function sectionProduction(sectionId: number): number | null {
  const r = db
    .query(
      `SELECT sl.production_id AS pid
       FROM song_sections ss JOIN script_lines sl ON sl.id = ss.song_line_id
       WHERE ss.id = ?`,
    )
    .get(sectionId) as { pid: number } | null;
  return r?.pid ?? null;
}

export function characterProduction(charId: number): number | null {
  const r = db.query("SELECT production_id FROM characters WHERE id = ?").get(charId) as
    | { production_id: number }
    | null;
  return r?.production_id ?? null;
}
