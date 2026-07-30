import { useState } from "react";
import type { Cue, Production, ScriptLine, SongSection } from "../types";
import { api } from "../api";
import { useWs } from "../ws";
import { CueEditor } from "./CueEditor";

interface Props {
  productionId: number;
  production?: Production; // threaded through to CueEditor for the audio preview
  songLine: ScriptLine;
  sections: SongSection[]; // already filtered to this song, seq order
  cues: Cue[]; // all production cues; filtered per-section here
  reload: () => void;
}

// Inline editor for a song's inner structure: ordered sections, each with a
// note and its own cues.
export function SongEditor({ productionId, production, songLine, sections, cues, reload }: Props) {
  const [addCueFor, setAddCueFor] = useState<number | null>(null);
  const [editCue, setEditCue] = useState<Cue | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");

  // Department-scoped notes: audio operators read/write `note_audio`.
  const { you } = useWs();
  const noteCol: "note" | "note_audio" = you?.role === "audio" ? "note_audio" : "note";

  // Role gates (mirrored server-side in server/auth.ts): structure is admin-only,
  // notes per role, cues per department.
  const role = you?.role;
  const isAdmin = !!you?.is_admin;
  const canStructure = isAdmin;
  const canNote = isAdmin || role === "caller" || role === "lights" || role === "audio";
  const canEditCue = (dept: string) =>
    isAdmin || ((role === "lights" || role === "audio") && role === dept);
  const canAddCue = isAdmin || role === "lights" || role === "audio";

  const isPause = songLine.type === "pause";

  async function addSection() {
    await api.addSection(songLine.id, "Section");
    reload();
  }

  // Pause quick action: pre-create the four standard break sections in order.
  // "Loop" is created with loop=1 so Show Mode treats it as an A/B flare.
  async function addBreakSections() {
    await api.addSection(songLine.id, "Break start");
    await api.addSection(songLine.id, "Loop", undefined, true);
    await api.addSection(songLine.id, "Warning");
    await api.addSection(songLine.id, "End");
    reload();
  }

  // Paste lyrics -> one section per stanza. Stanzas are split on blank lines
  // (one or more whitespace-only lines). New sections are appended after any
  // existing ones and numbered Verse (n+1)..(n+k) so labels stay unique.
  async function importLyrics() {
    const stanzas = importText
      .replace(/\r\n?/g, "\n")
      .split(/\n[ \t]*\n+/)
      .map((s) => s.replace(/^\n+|\n+$/g, ""))
      .filter((s) => s.trim().length > 0);
    if (stanzas.length === 0) {
      setImportOpen(false);
      setImportText("");
      return;
    }
    const base = sections.length;
    for (let i = 0; i < stanzas.length; i++) {
      await api.addSection(songLine.id, `Verse ${base + i + 1}`, stanzas[i]);
    }
    setImportText("");
    setImportOpen(false);
    reload();
  }

  async function move(section: SongSection, dir: -1 | 1) {
    const ordered = [...sections].sort((a, b) => a.seq - b.seq);
    const i = ordered.findIndex((s) => s.id === section.id);
    const j = i + dir;
    if (j < 0 || j >= ordered.length) return;
    [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    await api.reorderSections(songLine.id, ordered.map((s) => s.id));
    reload();
  }

  return (
    <div className="song-block">
      {sections.length === 0 && (
        <p className="hint">
          {isPause
            ? "No sections yet — add a break section, or use the quick action below."
            : "No sections yet — add verse, chorus, etc."}
        </p>
      )}
      {[...sections]
        .sort((a, b) => a.seq - b.seq)
        .map((s) => {
          const secCues = cues.filter((c) => c.anchor_type === "section" && c.anchor_id === s.id);
          return (
            <div key={s.id} style={{ marginBottom: 8 }}>
              <div className="section-row">
                <input
                  defaultValue={s.label}
                  placeholder="Section label (Verse 1, Chorus…)"
                  disabled={!canStructure}
                  onBlur={(e) =>
                    e.target.value !== s.label &&
                    api.patchSection(s.id, { label: e.target.value }).then(reload)
                  }
                />
                <div className="line-controls">
                  {(s.loop ? 1 : 0) === 1 && (
                    <span className="loop-marker" title="Loop section (A/B flare)">🔁</span>
                  )}
                  {canStructure && (
                    <>
                      <button
                        className={`btn-sm loop-toggle${s.loop ? " on" : ""}`}
                        title={s.loop ? "Loop on — click to turn off" : "Mark as loop section (A/B flare)"}
                        aria-pressed={s.loop ? "true" : "false"}
                        onClick={() =>
                          api.patchSection(s.id, { loop: s.loop ? 0 : 1 }).then(reload)
                        }
                      >
                        🔁 loop
                      </button>
                      <button className="btn-ghost btn-sm" title="Move up" onClick={() => move(s, -1)}>↑</button>
                      <button className="btn-ghost btn-sm" title="Move down" onClick={() => move(s, 1)}>↓</button>
                    </>
                  )}
                  {canAddCue && (
                    <button className="btn-sm" onClick={() => setAddCueFor(s.id)}>+ Cue</button>
                  )}
                  {canStructure && (
                    <button
                      className="btn-danger btn-sm"
                      onClick={() => api.deleteSection(s.id).then(reload)}
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
              <input
                className="note-line"
                style={{ width: "100%", marginTop: 4 }}
                defaultValue={s[noteCol]}
                placeholder={
                  noteCol === "note_audio" ? "Audio note for this section…" : "Note for this section…"
                }
                disabled={!canNote}
                onBlur={(e) =>
                  e.target.value !== s[noteCol] &&
                  api.patchSection(s.id, { [noteCol]: e.target.value }).then(reload)
                }
              />
              <textarea
                className="lyrics-input"
                style={{ width: "100%", marginTop: 4 }}
                rows={3}
                defaultValue={s.lyrics}
                placeholder="Lyrics for this section (optional)…"
                disabled={!canStructure}
                onBlur={(e) =>
                  e.target.value !== s.lyrics &&
                  api.patchSection(s.id, { lyrics: e.target.value }).then(reload)
                }
              />
              {secCues.length > 0 && (
                <div className="cue-chips">
                  {secCues.map((c) => {
                    const editable = canEditCue(c.department);
                    return (
                      <span
                        key={c.id}
                        className={"cue-chip dept-" + c.department}
                        onClick={editable ? () => setEditCue(c) : undefined}
                        style={{ cursor: editable ? "pointer" : "default" }}
                      >
                        {cueLabel(c)}
                        {editable && (
                          <span
                            className="x"
                            onClick={(e) => {
                              e.stopPropagation();
                              api.deleteCue(c.id).then(reload);
                            }}
                          >
                            ×
                          </span>
                        )}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      {canStructure && (
        <div className="row" style={{ marginTop: 4, gap: 8 }}>
          <button className="btn-sm" onClick={addSection}>+ Section</button>
          {isPause && sections.length === 0 && (
            <button className="btn-sm" onClick={addBreakSections}>+ Add break sections</button>
          )}
          {!isPause && (
            <button className="btn-sm" onClick={() => setImportOpen((v) => !v)}>
              {importOpen ? "Cancel import" : "Import lyrics"}
            </button>
          )}
        </div>
      )}

      {canStructure && importOpen && (
        <div style={{ marginTop: 8 }}>
          <p className="hint" style={{ marginTop: 0 }}>
            Paste lyrics. Blank lines split them into stanzas — one new section per stanza,
            labelled Verse 1, Verse 2, …
          </p>
          <textarea
            className="lyrics-input"
            style={{ width: "100%" }}
            rows={8}
            value={importText}
            placeholder={"Verse one line one\nVerse one line two\n\nVerse two line one\n…"}
            onChange={(e) => setImportText(e.target.value)}
          />
          <div className="row" style={{ marginTop: 4, gap: 8 }}>
            <button className="btn-primary btn-sm" onClick={importLyrics}>
              Import
            </button>
          </div>
        </div>
      )}

      {addCueFor !== null && (
        <CueEditor
          productionId={productionId}
          anchor={{ type: "section", id: addCueFor }}
          production={production}
          onClose={() => setAddCueFor(null)}
          reload={reload}
        />
      )}
      {editCue && (
        <CueEditor
          productionId={productionId}
          anchor={{ type: "section", id: editCue.anchor_id }}
          existing={editCue}
          production={production}
          onClose={() => setEditCue(null)}
          reload={reload}
        />
      )}
    </div>
  );
}

// The compact chip label shown against a line/section in the editors. Dept-aware
// so audio/spot cues read correctly (not an empty "Q ").
export function cueLabel(c: Cue): string {
  const suffix = c.label ? " · " + c.label : "";
  if (c.department === "audio") return `♪ ${c.avantis_scene || "?"}${suffix}`;
  if (c.department === "spot") return `${c.spot_target ? "Spot " + c.spot_target : "Spot"}${suffix}`;
  if (c.fire_mode === "go") return `GO${suffix}`;
  if (c.fire_mode === "cmd") return `CMD${suffix}`;
  return `Q ${c.cue_number}${suffix}`;
}
