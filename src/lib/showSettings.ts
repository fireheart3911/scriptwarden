import type { Production } from "../types";

// Per-production Show Mode "smart" settings. All default OFF / 0 so an existing
// production (settings === '{}') behaves byte-identically to before — EXCEPT
// rewindRearm, the one default-ON setting (v1 parity, §5.1).
export interface ShowSettings {
  goGuard: number; // 0 = off. Block GO when the armed cue is > goGuard items ahead.
  exitFire: boolean; // Exiting a loop via → also fires the newly armed cue.
  autoExec: boolean; // Forward arrows fire the non-loop cues they pass.
  followGo: boolean; // GO moves the reading position to just after the fired cue.
  scrollArmed: boolean; // Briefly scroll the armed cue into view when it changes.
  rewindRearm: boolean; // Caller rewind re-arms fired stops at/after the new position.
  spotCount: number; // How many followspots this production runs (1..9).
}

export const DEFAULT_SHOW_SETTINGS: ShowSettings = {
  goGuard: 0,
  exitFire: false,
  autoExec: false,
  followGo: false,
  scrollArmed: false,
  rewindRearm: true, // default ON — v1 parity (the one default-on setting)
  spotCount: 2, // the pre-setting era hardcode, so existing shows are unchanged
};

// Tolerant parse of a settings JSON blob merged over the defaults. Bad/empty
// JSON or non-object payloads fall back to defaults. Only known keys with the
// right primitive type are taken; everything else keeps its default. Shared by
// the client (parseShowSettings) and the server room (goGuard / rewindRearm).
export function parseShowSettingsJson(json: string): ShowSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(json || "{}");
  } catch {
    return { ...DEFAULT_SHOW_SETTINGS };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ...DEFAULT_SHOW_SETTINGS };
  }
  const src = raw as Record<string, unknown>;
  const out: ShowSettings = { ...DEFAULT_SHOW_SETTINGS };
  if (typeof src.goGuard === "number" && Number.isFinite(src.goGuard)) {
    out.goGuard = Math.max(0, Math.floor(src.goGuard));
  }
  if (typeof src.exitFire === "boolean") out.exitFire = src.exitFire;
  if (typeof src.autoExec === "boolean") out.autoExec = src.autoExec;
  if (typeof src.followGo === "boolean") out.followGo = src.followGo;
  if (typeof src.scrollArmed === "boolean") out.scrollArmed = src.scrollArmed;
  if (typeof src.rewindRearm === "boolean") out.rewindRearm = src.rewindRearm;
  if (typeof src.spotCount === "number" && Number.isFinite(src.spotCount)) {
    out.spotCount = Math.min(9, Math.max(1, Math.floor(src.spotCount)));
  }
  return out;
}

// Convenience wrapper for the client, which holds a full Production object.
export function parseShowSettings(p: Production): ShowSettings {
  return parseShowSettingsJson(p.settings || "{}");
}
