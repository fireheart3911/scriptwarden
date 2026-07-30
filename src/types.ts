import type { Department } from "../shared/protocol";

export type LineType =
  | "act"
  | "scene"
  | "character"
  | "dialogue"
  | "stage_dir"
  | "song"
  | "pause";
export type FireMode = "fire" | "go" | "cmd";
export type AnchorType = "line" | "section";

// Re-export so client modules can import the department union from ./types
// alongside the rest of the domain model (single source stays shared/protocol).
export type { Department };

export interface Production {
  id: number;
  name: string;
  osc_ip: string;
  osc_port: number;
  osc_protocol: "udp" | "tcp";
  osc_enabled: number;
  notes: string;
  settings: string;
  // v2: Avantis (audio console) MIDI-over-TCP config (mirrors osc_* naming) + join PIN.
  avantis_ip: string;
  avantis_port: number;
  avantis_channel: number;
  avantis_enabled: number;
  join_pin: string;
  created_at: string;
}

export interface Character {
  id: number;
  production_id: number;
  name: string;
  color: string;
}

export interface ScriptLine {
  id: number;
  production_id: number;
  seq: number;
  type: LineType;
  speaker: string;
  text: string;
  note: string; // lights note (legacy column — v1 shows were lights-run)
  note_audio: string; // audio operator's note (dept-scoped display)
  color_override: string | null;
}

export interface SongSection {
  id: number;
  song_line_id: number;
  seq: number;
  label: string;
  note: string; // lights note (legacy column)
  note_audio: string; // audio operator's note (dept-scoped display)
  lyrics: string;
  loop: number;
}

export interface Cue {
  id: number;
  production_id: number;
  anchor_type: AnchorType;
  anchor_id: number;
  cue_list: number;
  cue_number: string;
  label: string;
  notes: string;
  fire_mode: FireMode;
  cmd_text: string;
  // v2: department model. Existing cues default to 'lights' (correct for the
  // copied show); the fire path dispatches on department first (§2, §6).
  department: Department;
  spot_target: number; // 0 = all spots, 1..N = that spot (department === 'spot')
  avantis_scene: number; // 1..500 when department === 'audio'
  spot_pickup: string;
  spot_color: string;
  spot_size: string;
}

export interface Bundle {
  production: Production;
  characters: Character[];
  lines: ScriptLine[];
  sections: SongSection[];
  cues: Cue[];
}

export interface OscLogEntry {
  ts: string;
  address: string;
  args: (string | number)[];
  preview: string;
  sent: boolean;
  target?: string;
}
