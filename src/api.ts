import type { Bundle, Cue, LineType, OscLogEntry, Production, SongSection } from "./types";
import type { EosActiveCue, FireLogEntry, RosterEntry, Role, UserPublic } from "../shared/protocol";
import { getSession } from "./session";

async function req<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  // Attach the crew token (X-Token) to every request when we have an identity.
  // Only join / roster / admin routes actually check it (§3, LAN-trusted); it's
  // harmless on the open edit routes.
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = getSession()?.token;
  if (token) headers["X-Token"] = token;
  const res = await fetch(url, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (null as T);
}

export interface JoinInput {
  name: string;
  role: Role;
  spot_no?: number;
  pin?: string;
}
export interface NetInfo {
  port: number;
  ips: string[];
  urls: string[];
}

export interface ParsedLineInput {
  type: LineType;
  speaker: string;
  text: string;
}
export interface CharacterInput {
  name: string;
  color: string;
}

export const api = {
  // productions
  listProductions: () => req<Production[]>("GET", "/api/productions"),
  createProduction: (name: string) => req<Production>("POST", "/api/productions", { name }),
  bundle: (id: number) => req<Bundle>("GET", `/api/productions/${id}/bundle`),
  exportUrl: (id: number) => `/api/productions/${id}/export`,
  patchProduction: (id: number, patch: Partial<Production>) =>
    req<Production>("PATCH", `/api/productions/${id}`, patch),
  deleteProduction: (id: number) => req("DELETE", `/api/productions/${id}`),

  // script
  replaceScript: (id: number, lines: ParsedLineInput[], characters: CharacterInput[]) =>
    req("POST", `/api/productions/${id}/script`, { lines, characters }),
  addLine: (id: number, line: Partial<ParsedLineInput>) =>
    req("POST", `/api/productions/${id}/lines`, line),
  patchLine: (lineId: number, patch: Record<string, unknown>) =>
    req("PATCH", `/api/lines/${lineId}`, patch),
  deleteLine: (lineId: number) => req("DELETE", `/api/lines/${lineId}`),
  reorderLines: (id: number, orderedIds: number[]) =>
    req("POST", `/api/productions/${id}/lines/reorder`, { orderedIds }),

  // characters
  addCharacter: (id: number, name: string, color: string) =>
    req("POST", `/api/productions/${id}/characters`, { name, color }),
  patchCharacter: (charId: number, patch: Record<string, unknown>) =>
    req("PATCH", `/api/characters/${charId}`, patch),
  deleteCharacter: (charId: number) => req("DELETE", `/api/characters/${charId}`),

  // songs
  addSection: (lineId: number, label: string, lyrics?: string, loop?: boolean) =>
    req<SongSection>("POST", `/api/lines/${lineId}/sections`, { label, lyrics, loop }),
  patchSection: (sectionId: number, patch: Record<string, unknown>) =>
    req("PATCH", `/api/sections/${sectionId}`, patch),
  deleteSection: (sectionId: number) => req("DELETE", `/api/sections/${sectionId}`),
  reorderSections: (lineId: number, orderedIds: number[]) =>
    req("POST", `/api/lines/${lineId}/sections/reorder`, { orderedIds }),

  // cues
  addCue: (id: number, cue: Partial<Cue>) => req<Cue>("POST", `/api/productions/${id}/cues`, cue),
  patchCue: (cueId: number, patch: Partial<Cue>) => req<Cue>("PATCH", `/api/cues/${cueId}`, patch),
  deleteCue: (cueId: number) => req("DELETE", `/api/cues/${cueId}`),

  // osc / firing. Test-fire dispatches by department server-side (server/fire.ts):
  // lights → OscLogEntry, audio/spot → AvantisLogEntry. Now that ShowMode fires
  // through the server-authoritative WS `go` path (M2), the only caller is the Cue
  // Sheet's pre-show Test-fire / spot Flash, so this is typed as the FireLogEntry
  // union — consumers read only the common preview/sent fields.
  fireCue: (cueId: number) => req<FireLogEntry>("POST", `/api/cues/${cueId}/fire`, {}),
  go: (id: number) => req<OscLogEntry>("POST", `/api/productions/${id}/go`, {}),
  cmd: (id: number, text: string) => req<OscLogEntry>("POST", `/api/productions/${id}/cmd`, { text }),
  oscLog: () => req<{ config: any; log: OscLogEntry[] }>("GET", "/api/osc/log"),
  clearOscLog: () => req("DELETE", "/api/osc/log"),
  // the Ion's live active cue as seen by the Eos TCP monitor
  eosActive: (id: number) =>
    req<{ connected: boolean; cue: EosActiveCue | null }>("GET", `/api/productions/${id}/eos/active`),

  // avantis (audio console, M4)
  avantisTest: (id: number, scene: number) =>
    req<FireLogEntry>("POST", `/api/productions/${id}/avantis/test`, { scene }),
  avantisLog: () => req<{ config: any; log: FireLogEntry[] }>("GET", "/api/avantis/log"),

  // identity / live-sync (M1)
  netInfo: () => req<NetInfo>("GET", "/api/net-info"),
  join: (id: number, body: JoinInput) =>
    req<{ token: string; user: UserPublic }>("POST", `/api/productions/${id}/join`, body),
  roster: (id: number) => req<{ roster: RosterEntry[] }>("GET", `/api/productions/${id}/roster`),
  // admin (X-Token attached automatically)
  kick: (userId: number) => req<{ ok: boolean }>("POST", `/api/admin/kick`, { userId }),
  grantCaller: (userId: number) =>
    req<{ ok: boolean; callerUserId: number }>("POST", `/api/admin/caller`, { userId }),
};
