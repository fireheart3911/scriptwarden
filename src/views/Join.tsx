// src/views/Join.tsx — crew join screen (§3, M1).
//
// A crew member picks the production, types their name, chooses a role (+ spot
// number for spots), optionally enters the join PIN, and joins. On success the
// server returns a token + public user; we persist it (session.ts) and hand
// control back to App. Big touch targets — this is used on phones in a booth.

import { useEffect, useState } from "react";
import type { Production } from "../types";
import type { Role } from "../../shared/protocol";
import { api } from "../api";
import { parseShowSettings } from "../lib/showSettings";
import type { Identity } from "../session";

interface Props {
  onJoined: (id: Identity) => void;
  notice?: string | null;
}

const ROLES: { id: Role; label: string; hint: string }[] = [
  { id: "caller", label: "Caller", hint: "Drives the show — everyone follows you" },
  { id: "lights", label: "Lights", hint: "Ion / Eos operator" },
  { id: "audio", label: "Audio", hint: "Avantis / sound operator" },
  { id: "spot", label: "Spot", hint: "Followspot — big instruction cards" },
  { id: "regie", label: "Regie", hint: "Direction — follow the script, ready checks" },
  { id: "viewer", label: "Viewer", hint: "Follow along, read-only" },
];

export function Join({ onJoined, notice }: Props) {
  const [productions, setProductions] = useState<Production[]>([]);
  const [productionId, setProductionId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [spotNo, setSpotNo] = useState(1);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .listProductions()
      .then((list) => {
        setProductions(list);
        setProductionId((cur) => cur ?? list[0]?.id ?? null);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, []);

  async function createProduction() {
    const nm = prompt("New production name:", "Untitled Production");
    if (!nm) return;
    try {
      const p = await api.createProduction(nm);
      const list = await api.listProductions();
      setProductions(list);
      setProductionId(p.id);
    } catch (e) {
      setErr(String(e));
    }
  }

  async function submit() {
    if (productionId == null) {
      setErr("Pick a production to join.");
      return;
    }
    if (!name.trim()) {
      setErr("Enter your name.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await api.join(productionId, {
        name: name.trim(),
        role,
        spot_no: role === "spot" ? spotNo : 0,
        pin,
      });
      onJoined({
        token: res.token,
        name: res.user.name,
        role: res.user.role,
        spotNo: res.user.spot_no,
        productionId,
        userId: res.user.id,
        isAdmin: res.user.is_admin,
      });
    } catch (e) {
      const msg = String(e);
      if (msg.includes("-> 403")) setErr("Wrong PIN — ask the stage manager for the join PIN.");
      else if (msg.includes("name_required")) setErr("Enter your name.");
      else if (msg.includes("-> 404")) setErr("That production no longer exists.");
      else setErr(msg);
      setBusy(false);
    }
  }

  return (
    <div className="join-screen">
      <div className="join-card">
        <div className="join-brand">
          Script<span>Warden</span>
        </div>
        <p className="join-sub">Join the show</p>

        {notice && <div className="banner warn join-notice">{notice}</div>}

        {loading ? (
          <p className="muted">Loading…</p>
        ) : productions.length === 0 ? (
          <div className="join-empty">
            <p className="muted">No productions on this server yet.</p>
            <button className="btn-primary" onClick={createProduction}>
              Create a production
            </button>
          </div>
        ) : (
          <>
            {productions.length > 1 && (
              <label className="join-field">
                <span className="join-label">Production</span>
                <select
                  value={productionId ?? ""}
                  onChange={(e) => setProductionId(Number(e.target.value))}
                >
                  {productions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label className="join-field">
              <span className="join-label">Your name</span>
              <input
                autoFocus
                value={name}
                placeholder="e.g. Sam"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
              <span className="hint">
                Reusing a name rejoins as that crew member — your role updates and any notes are
                kept.
              </span>
            </label>

            <div className="join-field">
              <span className="join-label">Role</span>
              <div className="role-grid">
                {ROLES.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className={"role-btn" + (role === r.id ? " active" : "")}
                    onClick={() => setRole(r.id)}
                  >
                    <span className="role-name">{r.label}</span>
                    <span className="role-hint">{r.hint}</span>
                  </button>
                ))}
              </div>
            </div>

            {role === "spot" && (
              <label className="join-field">
                <span className="join-label">Spot number</span>
                <div className="spot-stepper">
                  <button type="button" onClick={() => setSpotNo((n) => Math.max(1, n - 1))}>
                    −
                  </button>
                  <span className="spot-no">{spotNo}</span>
                  <button
                    type="button"
                    onClick={() => {
                      // Cap at the production's followspot-count setting.
                      const p = productions.find((pr) => pr.id === productionId);
                      const max = p ? parseShowSettings(p).spotCount : 9;
                      setSpotNo((n) => Math.min(max, n + 1));
                    }}
                  >
                    +
                  </button>
                </div>
              </label>
            )}

            <label className="join-field">
              <span className="join-label">Join PIN (if required)</span>
              <input
                value={pin}
                placeholder="Leave blank if none"
                inputMode="numeric"
                onChange={(e) => setPin(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
            </label>

            {err && <div className="banner warn join-err">{err}</div>}

            <button className="btn-primary join-go" disabled={busy} onClick={submit}>
              {busy ? "Joining…" : "Join show"}
            </button>

            <p className="hint" style={{ marginTop: 8, textAlign: "center" }}>
              The first device to join a show becomes its admin (session PIN, console settings,
              crew management).
            </p>

            <button className="btn-ghost btn-sm join-new" onClick={createProduction}>
              + New production
            </button>
          </>
        )}
      </div>
    </div>
  );
}
