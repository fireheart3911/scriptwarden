import type { LineType } from "../types";
import { colorForIndex } from "./colors";

export interface ParsedLine {
  type: LineType;
  speaker: string;
  text: string;
}
export interface ParseResult {
  lines: ParsedLine[];
  characters: { name: string; color: string }[];
}
export interface ParseOptions {
  // A line beginning with this marker is treated as a whole song (one line per
  // song in the source script). Default is the ♪ music note.
  songMarker?: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Turn pasted script text into typed lines plus the distinct speakers found.
// Heuristics (all overridable by hand afterwards):
//   ♪ Title / SONG: Title        -> song
//   ACT / SCENE ...              -> act / scene header
//   (stage direction) or [..]    -> stage_dir
//   NAME: dialogue               -> dialogue by NAME
//   ALL CAPS short line          -> character heading (following lines inherit)
//   anything else                -> dialogue under the current speaker
export function parseScript(raw: string, opts: ParseOptions = {}): ParseResult {
  const songMarker = (opts.songMarker ?? "♪").trim();
  const markerRe = songMarker ? new RegExp("^" + escapeRegExp(songMarker)) : null;
  const trailingMarkerRe = songMarker ? new RegExp(escapeRegExp(songMarker) + "$") : null;

  const lines: ParsedLine[] = [];
  const speakers: string[] = [];
  const seen = new Set<string>();
  let current = "";

  const remember = (name: string) => {
    const n = name.trim();
    if (n && !seen.has(n)) {
      seen.add(n);
      speakers.push(n);
    }
    current = n;
  };

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // Song (one line per song)
    if ((markerRe && markerRe.test(line)) || /^song\s*[:\-]/i.test(line)) {
      let title = line;
      if (markerRe) title = title.replace(markerRe, "");
      title = title.replace(/^song\s*[:\-]\s*/i, "");
      if (trailingMarkerRe) title = title.replace(trailingMarkerRe, "");
      lines.push({ type: "song", speaker: "", text: title.trim() || "Song" });
      current = "";
      continue;
    }

    // Act / Scene headers
    if (/^act\b/i.test(line)) {
      lines.push({ type: "act", speaker: "", text: line });
      current = "";
      continue;
    }
    if (/^scene\b/i.test(line)) {
      lines.push({ type: "scene", speaker: "", text: line });
      current = "";
      continue;
    }

    // Stage direction: fully bracketed/parenthesised, or starts with "("
    if (/^[([].*[)\]]$/.test(line) || /^\(/.test(line)) {
      lines.push({ type: "stage_dir", speaker: "", text: line });
      continue;
    }

    // NAME: dialogue
    const m = line.match(/^([A-Z][A-Z0-9 .'\-]{0,30}):\s*(.*)$/);
    if (m) {
      remember(m[1]);
      lines.push({ type: "dialogue", speaker: current, text: m[2] });
      continue;
    }

    // Standalone ALL-CAPS name heading (screenplay style)
    if (/^[A-Z0-9 .'\-]{1,30}$/.test(line) && /[A-Z]/.test(line) && line === line.toUpperCase()) {
      remember(line);
      lines.push({ type: "character", speaker: current, text: "" });
      continue;
    }

    // Default: dialogue under the current speaker
    lines.push({ type: "dialogue", speaker: current, text: line });
  }

  const characters = speakers.map((name, i) => ({ name, color: colorForIndex(i) }));
  return { lines, characters };
}
