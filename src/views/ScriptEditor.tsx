import { useMemo, useState } from "react";
import type { Bundle, Cue, LineType, ScriptLine } from "../types";
import { api } from "../api";
import { useWs } from "../ws";
import { parseScript } from "../lib/scriptParser";
import { tint } from "../lib/colors";
import { ColorPicker } from "../components/ColorPicker";
import { CharactersPanel } from "../components/CharactersPanel";
import { SongEditor, cueLabel } from "../components/SongEditor";
import { CueEditor } from "../components/CueEditor";

const LINE_TYPES: LineType[] = ["dialogue", "character", "stage_dir", "act", "scene", "song", "pause"];

interface Props {
  bundle: Bundle;
  reload: () => void;
}

export function ScriptEditor({ bundle, reload }: Props) {
  const { production, characters, lines, sections, cues } = bundle;
  const [raw, setRaw] = useState("");
  const [marker, setMarker] = useState("♪");
  const [showImport, setShowImport] = useState(lines.length === 0);
  const [addCueForLine, setAddCueForLine] = useState<number | null>(null);
  const [editCue, setEditCue] = useState<Cue | null>(null);

  // Department-scoped notes: the audio operator reads/writes their own note
  // column (`note_audio`); everyone else works with the lights note (`note`).
  const { you } = useWs();
  const noteCol: "note" | "note_audio" = you?.role === "audio" ? "note_audio" : "note";

  // Role gates (mirrored server-side in server/auth.ts): only the admin edits
  // script STRUCTURE; caller/operators may annotate (their note column) and
  // lights/audio may manage cues of their own department.
  const role = you?.role;
  const isAdmin = !!you?.is_admin;
  const canStructure = isAdmin;
  const canNote = isAdmin || role === "caller" || role === "lights" || role === "audio";
  const canEditCue = (dept: string) =>
    isAdmin || ((role === "lights" || role === "audio") && role === dept);
  const canAddCue = isAdmin || role === "lights" || role === "audio";

  const colorOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of characters) map.set(c.name, c.color);
    return (line: ScriptLine) => line.color_override ?? map.get(line.speaker) ?? "";
  }, [characters]);

  async function doImport() {
    if (!raw.trim()) return;
    if (lines.length > 0 && !confirm("Replace the entire current script? This cannot be undone.")) return;
    const parsed = parseScript(raw, { songMarker: marker });
    await api.replaceScript(production.id, parsed.lines, parsed.characters);
    setRaw("");
    setShowImport(false);
    reload();
  }

  async function move(line: ScriptLine, dir: -1 | 1) {
    const ordered = [...lines].sort((a, b) => a.seq - b.seq);
    const i = ordered.findIndex((l) => l.id === line.id);
    const j = i + dir;
    if (j < 0 || j >= ordered.length) return;
    [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    await api.reorderLines(production.id, ordered.map((l) => l.id));
    reload();
  }

  async function addLine() {
    await api.addLine(production.id, { type: "dialogue", speaker: "", text: "" });
    reload();
  }

  // Insert a fresh empty dialogue line directly below `after`. addLine appends
  // to the end; we then reorder so the new line lands right after the clicked
  // row. The new line's id is the largest since it was just created.
  async function insertBelow(after: ScriptLine) {
    await api.addLine(production.id, { type: "dialogue", speaker: "", text: "" });
    const fresh = await api.bundle(production.id);
    const current = [...fresh.lines].sort((a, b) => a.seq - b.seq);
    const newLine = fresh.lines.reduce((max, l) => (l.id > max.id ? l : max), fresh.lines[0]);
    const rest = current.filter((l) => l.id !== newLine.id);
    const idx = rest.findIndex((l) => l.id === after.id);
    const orderedIds = [
      ...rest.slice(0, idx + 1).map((l) => l.id),
      newLine.id,
      ...rest.slice(idx + 1).map((l) => l.id),
    ];
    await api.reorderLines(production.id, orderedIds);
    reload();
  }

  const ordered = [...lines].sort((a, b) => a.seq - b.seq);

  return (
    <div>
      <div className="panel">
        <h3 className="panel-title">
          Script — {production.name}
          <span className="spacer" />
          {canStructure ? (
            <button className="btn-sm" onClick={() => setShowImport((s) => !s)}>
              {showImport ? "Hide import" : "Paste / import script"}
            </button>
          ) : (
            <span className="hint">read-only — the show admin edits the script</span>
          )}
        </h3>
        {canStructure && showImport && (
          <div>
            <p className="hint">
              Paste your script below. Lines are auto-classified (you can fix any afterwards).
              A line starting with the song marker becomes a single <b>song</b> you can expand into
              sections. <code>NAME:</code> lines become dialogue and create characters.
            </p>
            <textarea
              rows={8}
              value={raw}
              placeholder={"ACT 1\nSCENE 1\nHAMLET: To be or not to be…\n(lights dim)\n♪ Opening Number"}
              onChange={(e) => setRaw(e.target.value)}
            />
            <div className="row" style={{ marginTop: 8 }}>
              <label className="hint">Song marker</label>
              <input value={marker} onChange={(e) => setMarker(e.target.value)} style={{ width: 60 }} />
              <span className="spacer" />
              <button className="btn-primary" onClick={doImport}>Parse & Replace script</button>
            </div>
          </div>
        )}
      </div>

      {canStructure && (
        <CharactersPanel productionId={production.id} characters={characters} reload={reload} />
      )}

      <div className="panel">
        <h3 className="panel-title">
          Lines <span className="hint">({ordered.length})</span>
          <span className="spacer" />
          {canStructure && <button className="btn-sm" onClick={addLine}>+ Line</button>}
        </h3>
        {ordered.length === 0 && <p className="empty">No lines yet. Paste a script above to get started.</p>}

        {ordered.map((line) => {
          const color = colorOf(line);
          const lineCues = cues.filter((c) => c.anchor_type === "line" && c.anchor_id === line.id);
          const songSections = sections.filter((s) => s.song_line_id === line.id);
          return (
            <div key={line.id}>
              <div
                className={`line-row type-${line.type}`}
                style={{
                  // Only override the border/tint when there's a speaker color,
                  // so type-song's CSS violet border + tint show through (inline
                  // styles would otherwise beat the type class).
                  borderLeftColor: color || undefined,
                  background: color ? tint(color, 0.1) : undefined,
                }}
              >
                <select
                  value={line.type}
                  disabled={!canStructure}
                  onChange={(e) => api.patchLine(line.id, { type: e.target.value }).then(reload)}
                >
                  {LINE_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>

                {line.type === "dialogue" || line.type === "character" ? (
                  <input
                    list="character-names"
                    defaultValue={line.speaker}
                    placeholder="Speaker"
                    disabled={!canStructure}
                    onBlur={(e) =>
                      e.target.value !== line.speaker &&
                      api.patchLine(line.id, { speaker: e.target.value }).then(reload)
                    }
                  />
                ) : (
                  <span className="muted" style={{ alignSelf: "center", fontSize: 12 }}>
                    {line.type === "song" ? "🎵 song" : line.type === "pause" ? "⏸ pause" : line.type}
                  </span>
                )}

                <div>
                  <input
                    className="line-text-input"
                    defaultValue={line.text}
                    placeholder={
                      line.type === "song" ? "Song title" : line.type === "pause" ? "Pause / break label" : "Text…"
                    }
                    disabled={!canStructure}
                    onBlur={(e) =>
                      e.target.value !== line.text &&
                      api.patchLine(line.id, { text: e.target.value }).then(reload)
                    }
                  />
                  {(line[noteCol] || false) && (
                    <input
                      className="note-line"
                      defaultValue={line[noteCol]}
                      placeholder={noteCol === "note_audio" ? "Audio note…" : "Note…"}
                      onBlur={(e) =>
                        e.target.value !== line[noteCol] &&
                        api.patchLine(line.id, { [noteCol]: e.target.value }).then(reload)
                      }
                    />
                  )}
                  {lineCues.length > 0 && (
                    <div className="cue-chips">
                      {lineCues.map((c) => {
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

                <div className="line-controls">
                  {canStructure && (
                    <ColorPicker
                      value={line.color_override}
                      allowClear
                      title="Override line color"
                      onChange={(c) => api.patchLine(line.id, { color_override: c }).then(reload)}
                    />
                  )}
                  {canNote && (
                    <button
                      className="btn-ghost btn-sm"
                      title="Toggle note"
                      onClick={() =>
                        api.patchLine(line.id, { [noteCol]: line[noteCol] ? "" : " " }).then(reload)
                      }
                    >
                      🗒
                    </button>
                  )}
                  {canAddCue && (
                    <button className="btn-sm" title="Add cue" onClick={() => setAddCueForLine(line.id)}>+Q</button>
                  )}
                  {canStructure && (
                    <>
                      <button
                        className="btn-ghost btn-sm"
                        title="Insert line below"
                        onClick={() => insertBelow(line)}
                      >
                        ↳+
                      </button>
                      <button className="btn-ghost btn-sm" title="Move up" onClick={() => move(line, -1)}>↑</button>
                      <button className="btn-ghost btn-sm" title="Move down" onClick={() => move(line, 1)}>↓</button>
                      <button
                        className="btn-danger btn-sm"
                        title="Delete line"
                        onClick={() => api.deleteLine(line.id).then(reload)}
                      >
                        ×
                      </button>
                    </>
                  )}
                </div>
              </div>
              {(line.type === "song" || line.type === "pause") && (
                <SongEditor
                  productionId={production.id}
                  production={production}
                  songLine={line}
                  sections={songSections}
                  cues={cues}
                  reload={reload}
                />
              )}
            </div>
          );
        })}
      </div>

      <datalist id="character-names">
        {characters.map((c) => (
          <option key={c.id} value={c.name} />
        ))}
      </datalist>

      {addCueForLine !== null && (
        <CueEditor
          productionId={production.id}
          anchor={{ type: "line", id: addCueForLine }}
          production={production}
          onClose={() => setAddCueForLine(null)}
          reload={reload}
        />
      )}
      {editCue && (
        <CueEditor
          productionId={production.id}
          anchor={{ type: editCue.anchor_type, id: editCue.anchor_id }}
          existing={editCue}
          production={production}
          onClose={() => setEditCue(null)}
          reload={reload}
        />
      )}
    </div>
  );
}
