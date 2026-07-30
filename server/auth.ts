// server/auth.ts — crew-token permission helpers for the edit routes.
//
// The join/admin routes had token checks from M1; script/song/character/cue
// mutations were LAN-open. Now they are role-guarded: only the admin edits the
// script structure, operators may add/edit cues OF THEIR OWN DEPARTMENT, and
// note columns are writable per role (lights → note, audio → note_audio,
// caller/admin → both). Reads (bundle, export, logs) stay open.

import type { Context } from "hono";
import { getUserByToken, type UserRow } from "./users";

// X-Token -> the active (non-revoked) crew row, or null.
export function crewFromToken(c: Context): UserRow | null {
  const u = getUserByToken(c.req.header("X-Token") ?? "");
  if (!u || u.revoked) return null;
  return u;
}

// The admin of `productionId`, or null. Used by the structural script routes.
export function adminOf(c: Context, productionId: number | null | undefined): UserRow | null {
  const u = crewFromToken(c);
  if (!u || !u.is_admin || u.production_id !== productionId) return null;
  return u;
}

// Line/section note columns this user may patch. Empty set = notes read-only.
export function allowedNoteCols(u: UserRow): Set<string> {
  if (u.is_admin || u.role === "caller") return new Set(["note", "note_audio"]);
  if (u.role === "lights") return new Set(["note"]);
  if (u.role === "audio") return new Set(["note_audio"]);
  return new Set();
}

// May this user create/edit/delete a cue of `department`? Admin: any dept;
// lights/audio operators: exactly their own department.
export function mayEditCue(u: UserRow, department: string): boolean {
  if (u.is_admin) return true;
  return (u.role === "lights" || u.role === "audio") && u.role === department;
}

const forbidden = { error: "forbidden" } as const;
export function deny(c: Context) {
  return c.json(forbidden, 403);
}
