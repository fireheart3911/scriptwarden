import { useState } from "react";
import type { AnchorType, Cue, Department, FireMode, Production } from "../types";
import { api } from "../api";
import { useWs } from "../ws";
import { buildCuePreview } from "../lib/preview";
import { DEFAULT_SHOW_SETTINGS, parseShowSettings } from "../lib/showSettings";

interface Props {
  productionId: number;
  anchor: { type: AnchorType; id: number };
  existing?: Cue;
  // Optional: enables an accurate audio preview (base MIDI channel + target host)
  // and future dept-specific defaults. Absent from some call sites (song editor) —
  // the audio preview then falls back to channel 1 / "unconfigured".
  production?: Production;
  onClose: () => void;
  reload: () => void;
}

const DEPTS: { dept: Department; label: string }[] = [
  { dept: "lights", label: "Lights" },
  { dept: "audio", label: "Audio" },
  { dept: "spot", label: "Spot" },
];

// Add or edit a single cue. The DEPARTMENT selector is the first control; the
// fields below swap per department (§6):
//   lights → Eos fire/go/cmd (v1 editor verbatim) + /eos preview
//   audio  → Avantis scene number (1..500) + label/notes + MIDI-hex preview
//   spot   → target/pickup/color/size + notes + instruction-card preview
export function CueEditor({ productionId, anchor, existing, production, onClose, reload }: Props) {
  // Non-admin operators only manage cues of their own department (enforced
  // server-side too): lock the selector to their role.
  const { you } = useWs();
  const lockedDept: Department | null =
    !you?.is_admin && (you?.role === "lights" || you?.role === "audio") ? you.role : null;
  const [dept, setDept] = useState<Department>(
    lockedDept ?? existing?.department ?? "lights",
  );
  // lights fields
  const [fireMode, setFireMode] = useState<FireMode>(existing?.fire_mode ?? "fire");
  const [cueList, setCueList] = useState(String(existing?.cue_list ?? 1));
  const [cueNumber, setCueNumber] = useState(existing?.cue_number ?? "");
  // audio fields
  const [avantisScene, setAvantisScene] = useState(
    existing?.avantis_scene ? String(existing.avantis_scene) : "",
  );
  // spot fields
  const [spotTarget, setSpotTarget] = useState(existing?.spot_target ?? 0);
  const [spotPickup, setSpotPickup] = useState(existing?.spot_pickup ?? "");
  const [spotColor, setSpotColor] = useState(existing?.spot_color ?? "");
  const [spotSize, setSpotSize] = useState(existing?.spot_size ?? "");
  // shared
  const [label, setLabel] = useState(existing?.label ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [cmdText, setCmdText] = useState(existing?.cmd_text ?? "");
  const [saving, setSaving] = useState(false);

  const sceneNum = Number(avantisScene);
  const sceneOk = Number.isInteger(sceneNum) && sceneNum >= 1 && sceneNum <= 500;
  const canSave = dept !== "audio" || sceneOk;

  // Draft cue used to render the live preview via the shared, dept-aware builder.
  const draft = {
    ...(existing ?? {}),
    department: dept,
    fire_mode: fireMode,
    cue_list: Number(cueList) || 1,
    cue_number: cueNumber,
    cmd_text: cmdText,
    avantis_scene: Number(avantisScene) || 0,
    spot_target: spotTarget,
    spot_pickup: spotPickup,
    spot_color: spotColor,
    spot_size: spotSize,
    label,
    notes,
  } as Cue;
  const preview = buildCuePreview(draft, production);

  async function save() {
    setSaving(true);
    // Send every dept column so switching a cue's department fully overwrites any
    // stale fields (the fire path dispatches on `department`, but a clean row is
    // easier to reason about). The server whitelists each column independently.
    const payload: Partial<Cue> = {
      anchor_type: anchor.type,
      anchor_id: anchor.id,
      department: dept,
      label: label.trim(),
      notes: notes.trim(),
      // lights
      fire_mode: fireMode,
      cue_list: Number(cueList) || 1,
      cue_number: cueNumber.trim(),
      cmd_text: cmdText,
      // audio
      avantis_scene: Number(avantisScene) || 0,
      // spot
      spot_target: spotTarget,
      spot_pickup: spotPickup.trim(),
      spot_color: spotColor.trim(),
      spot_size: spotSize.trim(),
    };
    if (existing) await api.patchCue(existing.id, payload);
    else await api.addCue(productionId, payload);
    setSaving(false);
    reload();
    onClose();
  }

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50,
      }}
      onClick={onClose}
    >
      <div className="panel" style={{ width: 420, margin: 0 }} onClick={(e) => e.stopPropagation()}>
        <h3 className="panel-title">{existing ? "Edit cue" : "Add cue"}</h3>

        <label className="hint">Department</label>
        <div className="dept-select">
          {DEPTS.filter(({ dept: d }) => !lockedDept || d === lockedDept).map(
            ({ dept: d, label: l }) => (
              <button
                key={d}
                className={`dept-btn dept-${d}${dept === d ? " active" : ""}`}
                disabled={!!lockedDept}
                onClick={() => setDept(d)}
              >
                {l}
              </button>
            ),
          )}
        </div>

        {dept === "lights" && (
          <>
            <label className="hint">Action</label>
            <div className="row" style={{ marginBottom: 10 }}>
              {(["fire", "go", "cmd"] as FireMode[]).map((m) => (
                <button
                  key={m}
                  className={fireMode === m ? "btn-primary btn-sm" : "btn-sm"}
                  onClick={() => setFireMode(m)}
                >
                  {m === "fire" ? "Fire cue" : m === "go" ? "GO" : "Command"}
                </button>
              ))}
            </div>

            {fireMode === "fire" && (
              <div className="row" style={{ marginBottom: 10 }}>
                <div style={{ flex: "0 0 90px" }}>
                  <label className="hint">Cue list</label>
                  <input value={cueList} onChange={(e) => setCueList(e.target.value)} style={{ width: "100%" }} />
                </div>
                <div style={{ flex: 1 }}>
                  <label className="hint">Cue number</label>
                  <input
                    value={cueNumber}
                    placeholder="e.g. 12 or 12.5"
                    onChange={(e) => setCueNumber(e.target.value)}
                    style={{ width: "100%" }}
                    autoFocus
                  />
                </div>
              </div>
            )}

            {fireMode === "cmd" && (
              <div style={{ marginBottom: 10 }}>
                <label className="hint">Command line text</label>
                <input
                  value={cmdText}
                  placeholder="e.g. Chan 1 Thru 10 At Full"
                  onChange={(e) => setCmdText(e.target.value)}
                  style={{ width: "100%" }}
                />
              </div>
            )}
          </>
        )}

        {dept === "audio" && (
          <div style={{ marginBottom: 10 }}>
            <label className="hint">Avantis scene (1–500)</label>
            <input
              value={avantisScene}
              placeholder="e.g. 264"
              inputMode="numeric"
              onChange={(e) => setAvantisScene(e.target.value.replace(/[^0-9]/g, ""))}
              style={{
                width: "100%",
                borderColor: avantisScene && !sceneOk ? "var(--danger)" : undefined,
              }}
              autoFocus
            />
            {avantisScene && !sceneOk && (
              <span className="hint" style={{ color: "var(--danger)", display: "block", marginTop: 4 }}>
                Scene must be a whole number from 1 to 500.
              </span>
            )}
          </div>
        )}

        {dept === "spot" && (
          <>
            <div style={{ marginBottom: 10 }}>
              <label className="hint">Target</label>
              <select
                value={spotTarget}
                onChange={(e) => setSpotTarget(Number(e.target.value))}
                style={{ width: "100%" }}
              >
                <option value={0}>All spots</option>
                {(() => {
                  // Offer Spot 1..N from the production's followspot-count
                  // setting; an existing target beyond N stays selectable so a
                  // lowered count never hides a cue's real target.
                  const count = production
                    ? parseShowSettings(production).spotCount
                    : DEFAULT_SHOW_SETTINGS.spotCount;
                  const max = Math.max(count, spotTarget);
                  return Array.from({ length: max }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      Spot {n}
                      {n > count ? " (beyond spot count)" : ""}
                    </option>
                  ));
                })()}
              </select>
            </div>
            <div className="row" style={{ marginBottom: 10 }}>
              <div style={{ flex: 1 }}>
                <label className="hint">Pick up</label>
                <input
                  value={spotPickup}
                  placeholder="e.g. Hamlet"
                  onChange={(e) => setSpotPickup(e.target.value)}
                  style={{ width: "100%" }}
                />
              </div>
              <div style={{ flex: "0 0 110px" }}>
                <label className="hint">Color</label>
                <input
                  value={spotColor}
                  placeholder="e.g. CTB"
                  onChange={(e) => setSpotColor(e.target.value)}
                  style={{ width: "100%" }}
                />
              </div>
              <div style={{ flex: "0 0 90px" }}>
                <label className="hint">Size</label>
                <input
                  value={spotSize}
                  placeholder="e.g. tight"
                  onChange={(e) => setSpotSize(e.target.value)}
                  style={{ width: "100%" }}
                />
              </div>
            </div>
          </>
        )}

        <div style={{ marginBottom: 10 }}>
          <label className="hint">Label</label>
          <input value={label} placeholder="e.g. Spot up on Hamlet" onChange={(e) => setLabel(e.target.value)} style={{ width: "100%" }} />
        </div>

        <div style={{ marginBottom: 10 }}>
          <label className="hint">Notes</label>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        <div className="banner" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
          <span className="muted">Will send: </span>
          <span style={{ fontFamily: "var(--mono)", color: "var(--accent)" }}>{preview}</span>
        </div>

        <div className="row">
          <span className="spacer" />
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={saving || !canSave}>
            {existing ? "Save" : "Add cue"}
          </button>
        </div>
      </div>
    </div>
  );
}
