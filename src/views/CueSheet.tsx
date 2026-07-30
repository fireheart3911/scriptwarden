import { useMemo, useState } from "react";
import type { Bundle, Cue, Department } from "../types";
import type { FireLogEntry } from "../../shared/protocol";
import { api } from "../api";
import { useWs } from "../ws";
import { buildOrder, cueStops } from "../../shared/runningOrder";
import { buildCuePreview } from "../lib/preview";
import { CueEditor } from "../components/CueEditor";

interface Props {
  bundle: Bundle;
  reload: () => void;
}

type Filter = "all" | Department;

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "lights", label: "Lights" },
  { key: "audio", label: "Audio" },
  { key: "spot", label: "Spot" },
];

// Flat, ordered list of every cue with the script context it fires against.
// Department-aware: a colored chip per cue, filter chips to narrow by dept, and a
// per-dept test-fire (spot fires as "Flash" — the pre-show spot-screen check).
export function CueSheet({ bundle, reload }: Props) {
  const { production, lines, sections, cues } = bundle;
  const [editCue, setEditCue] = useState<Cue | null>(null);
  const [lastFire, setLastFire] = useState<FireLogEntry | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  // Role gate (mirrored server-side): admin edits any cue, operators only their
  // own department. Test-fire stays open — it's the pre-show hardware check.
  const { you } = useWs();
  const canEditCue = (dept: Department) =>
    !!you?.is_admin || ((you?.role === "lights" || you?.role === "audio") && you.role === dept);

  const stops = useMemo(
    () => cueStops(buildOrder(lines, sections, cues)),
    [lines, sections, cues],
  );

  const counts = useMemo(() => {
    const c = { all: 0, lights: 0, audio: 0, spot: 0 };
    for (const e of stops) {
      for (const q of e.cues) {
        c.all++;
        if (q.department === "audio" || q.department === "spot") c[q.department]++;
        else c.lights++;
      }
    }
    return c;
  }, [stops]);

  // Stops with at least one cue passing the active dept filter (cues filtered too).
  const visible = useMemo(
    () =>
      stops
        .map((e) => ({ entry: e, cues: e.cues.filter((c) => filter === "all" || c.department === filter) }))
        .filter((x) => x.cues.length > 0),
    [stops, filter],
  );

  function context(entry: (typeof stops)[number]): string {
    if (entry.kind === "section") {
      return `🎵 ${entry.line.text || "Song"} › ${entry.section?.label || "section"}`;
    }
    const l = entry.line;
    if (l.type === "act" || l.type === "scene") return l.text;
    if (l.speaker) return `${l.speaker}: ${l.text}`;
    return l.text || `(${l.type})`;
  }

  async function testFire(c: Cue) {
    const entry = await api.fireCue(c.id);
    setLastFire(entry);
  }

  return (
    <div>
      <div className="panel">
        <h3 className="panel-title">
          Cue Sheet <span className="hint">({counts.all} cues)</span>
          <span className="spacer" />
          {lastFire && (
            <span className="hint" style={{ fontFamily: "var(--mono)" }}>
              last: <span style={{ color: lastFire.sent ? "var(--accent-2)" : "var(--warn)" }}>
                {lastFire.sent ? "SENT" : "STUB"}
              </span>{" "}
              {lastFire.preview}
            </span>
          )}
        </h3>

        <div className="filter-chips">
          {FILTERS.map(({ key, label }) => (
            <button
              key={key}
              className={`filter-chip${key === "all" ? "" : ` dept-${key}`}${filter === key ? " active" : ""}`}
              onClick={() => setFilter(key)}
            >
              {label} <span className="filter-count">{counts[key]}</span>
            </button>
          ))}
        </div>

        {stops.length === 0 ? (
          <p className="empty">No cues yet. Add cues from the Script tab.</p>
        ) : visible.length === 0 ? (
          <p className="empty">No {filter} cues.</p>
        ) : (
          <table className="cue-table">
            <thead>
              <tr>
                <th style={{ width: 74 }}>Dept</th>
                <th style={{ width: 80 }}>Cue</th>
                <th>Label</th>
                <th>Where it fires</th>
                <th>Sends</th>
                <th>Notes</th>
                <th style={{ width: 160 }}></th>
              </tr>
            </thead>
            <tbody>
              {visible.flatMap(({ entry, cues: rowCues }) =>
                rowCues.map((c) => (
                  <tr key={c.id}>
                    <td><DeptChip dept={c.department} /></td>
                    <td className="cue-num">{cueIdent(c)}</td>
                    <td>{c.label || <span className="muted">—</span>}</td>
                    <td className="muted">{context(entry)}</td>
                    <td className="cue-sends muted">{buildCuePreview(c, production)}</td>
                    <td className="muted">{c.notes}</td>
                    <td>
                      <div className="row">
                        <button className="btn-sm" onClick={() => testFire(c)}>
                          {c.department === "spot" ? "Flash" : "Test fire"}
                        </button>
                        {canEditCue(c.department) && (
                          <>
                            <button className="btn-ghost btn-sm" onClick={() => setEditCue(c)}>Edit</button>
                            <button className="btn-danger btn-sm" onClick={() => api.deleteCue(c.id).then(reload)}>×</button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        )}
      </div>

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

function DeptChip({ dept }: { dept: Department }) {
  const label = dept.charAt(0).toUpperCase() + dept.slice(1);
  return <span className={`dept-chip dept-${dept}`}>{label}</span>;
}

// The department-appropriate identity token shown in the "Cue" column.
function cueIdent(c: Cue): string {
  if (c.department === "audio") return `Scene ${c.avantis_scene || "?"}`;
  if (c.department === "spot") return c.spot_target ? `Spot ${c.spot_target}` : "All";
  return c.fire_mode === "fire" ? c.cue_number : c.fire_mode.toUpperCase();
}
