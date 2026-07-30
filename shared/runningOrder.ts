import type { Cue, ScriptLine, SongSection } from "../src/types";

// One stop in the walk through the show: either a script line, or a section
// within a song. Carries whatever cues are anchored to it.
export interface OrderEntry {
  key: string;
  kind: "line" | "section";
  line: ScriptLine;
  section?: SongSection;
  cues: Cue[];
}

// Walk lines in seq order, expanding each song line into its sections, and
// attach cues to their anchor. Shared by the cue sheet and show mode.
export function buildOrder(
  lines: ScriptLine[],
  sections: SongSection[],
  cues: Cue[],
): OrderEntry[] {
  const sectionsByLine = new Map<number, SongSection[]>();
  for (const s of sections) {
    const arr = sectionsByLine.get(s.song_line_id) ?? [];
    arr.push(s);
    sectionsByLine.set(s.song_line_id, arr);
  }
  for (const arr of sectionsByLine.values()) arr.sort((a, b) => a.seq - b.seq);

  const cuesFor = (type: "line" | "section", id: number) =>
    cues
      .filter((c) => c.anchor_type === type && c.anchor_id === id)
      .sort((a, b) => a.cue_list - b.cue_list || cmpCueNumber(a.cue_number, b.cue_number));

  const out: OrderEntry[] = [];
  const ordered = [...lines].sort((a, b) => a.seq - b.seq);
  for (const line of ordered) {
    out.push({ key: `line-${line.id}`, kind: "line", line, cues: cuesFor("line", line.id) });
    if (line.type === "song" || line.type === "pause") {
      for (const section of sectionsByLine.get(line.id) ?? []) {
        out.push({
          key: `sec-${section.id}`,
          kind: "section",
          line,
          section,
          cues: cuesFor("section", section.id),
        });
      }
    }
  }
  return out;
}

// Only the stops that actually fire something, in order — the show-mode stack.
export function cueStops(order: OrderEntry[]): OrderEntry[] {
  return order.filter((e) => e.cues.length > 0);
}

// "Landmarks" are the entries Show Mode's left/right arrows jump between: the
// start of each structural block. An entry is a landmark when ANY of:
//   - it's a song section (kind === "section"), OR
//   - its line type is act / scene / song, OR
//   - it's the first line of a new speaker block: a dialogue/character line
//     whose speaker differs from the nearest previous entry that carried a
//     non-empty speaker.
// Stage directions are never landmarks. Returns the sorted indices into `order`.
export function landmarkIndices(order: OrderEntry[]): number[] {
  const out: number[] = [];
  let prevSpeaker = "";
  for (let i = 0; i < order.length; i++) {
    const entry = order[i];
    const type = entry.line.type;
    let isLandmark = false;
    if (entry.kind === "section" || type === "act" || type === "scene" || type === "song") {
      isLandmark = true;
    } else if ((type === "dialogue" || type === "character") && entry.line.speaker) {
      if (entry.line.speaker !== prevSpeaker) isLandmark = true;
    }
    if (isLandmark) out.push(i);
    // Track the last non-empty speaker so a new speaker block is detected even
    // across stage directions or other speakerless lines.
    if (entry.line.speaker) prevSpeaker = entry.line.speaker;
  }
  return out;
}

// "Scene starts" are the entries the Show Mode scene header lists and jumps
// between: the structural boundaries of the show. An entry qualifies when it's
// a line (not a song/pause section) whose type is act, scene, or pause. Returns
// the sorted indices into `order`. Used by the sticky scene header + its menu.
export function sceneStartIndices(order: OrderEntry[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < order.length; i++) {
    const entry = order[i];
    if (entry.kind !== "line") continue;
    const type = entry.line.type;
    if (type === "act" || type === "scene" || type === "pause") out.push(i);
  }
  return out;
}

// The scene that contains `cursor`: the nearest scene-start at or before it.
// Returns -1 if the cursor precedes every scene start (fallback to first / name
// is the caller's choice). `starts` must be the output of sceneStartIndices.
export function currentSceneStart(starts: number[], cursor: number): number {
  let found = -1;
  for (const idx of starts) {
    if (idx <= cursor) found = idx;
    else break;
  }
  return found;
}

// Nearest landmark strictly before `cursor` (clamped: -1 if none). `landmarks`
// must be the sorted output of landmarkIndices.
export function prevLandmark(landmarks: number[], cursor: number): number {
  let found = -1;
  for (const idx of landmarks) {
    if (idx < cursor) found = idx;
    else break;
  }
  return found;
}

// Nearest landmark strictly after `cursor` (clamped: -1 if none).
export function nextLandmark(landmarks: number[], cursor: number): number {
  for (const idx of landmarks) {
    if (idx > cursor) return idx;
  }
  return -1;
}

// Natural-ish sort for Eos cue numbers ("2" < "10", "1.5" between).
function cmpCueNumber(a: string, b: string): number {
  const na = parseFloat(a);
  const nb = parseFloat(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
  return a.localeCompare(b);
}
