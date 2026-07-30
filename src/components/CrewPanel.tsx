// src/components/CrewPanel.tsx — admin crew management (§3, §5.3).
//
// Admin-only. Lists the roster live (from the WS `roster` broadcasts), with a
// "Make caller" (grant/transfer authority) and "Kick" action per member, plus
// the join QR/URL so new crew can get on. Actions go over the token-guarded HTTP
// admin routes; the server broadcasts the resulting roster/callerChanged, so the
// list updates itself — no local mutation needed.

import { useState } from "react";
import type { RosterEntry } from "../../shared/protocol";
import { api } from "../api";
import { useWs } from "../ws";
import { QrCode } from "./QrCode";

export function CrewPanel() {
  const { roster, you, state } = useWs();
  const callerId = state?.callerUserId ?? null;
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function makeCaller(userId: number) {
    setBusy(userId);
    setErr(null);
    try {
      await api.grantCaller(userId);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function kick(entry: RosterEntry) {
    if (!confirm(`Remove ${entry.user.name} from the show? Their token stops working.`)) return;
    setBusy(entry.user.id);
    setErr(null);
    try {
      await api.kick(entry.user.id);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="panel">
      <h3 className="panel-title">Crew</h3>

      <div className="crew-list">
        {roster.length === 0 && <div className="muted">No crew yet.</div>}
        {roster.map((r) => {
          const isSelf = you?.id === r.user.id;
          const isCaller = callerId === r.user.id;
          return (
            <div key={r.user.id} className="crew-row">
              <span className={"dot " + (r.online ? "dot-online" : "dot-offline")} />
              <span className="crew-name">
                {r.user.name}
                {isSelf && <span className="crew-you"> (you)</span>}
              </span>
              <span className="crew-role">
                {r.user.role}
                {r.user.role === "spot" && r.user.spot_no ? ` ${r.user.spot_no}` : ""}
              </span>
              {isCaller && <span className="badge badge-caller">CALLER</span>}
              {r.user.is_admin && <span className="badge badge-admin">ADMIN</span>}
              <span className="spacer" />
              {!isCaller && (
                <button
                  className="btn-sm"
                  disabled={busy === r.user.id}
                  onClick={() => makeCaller(r.user.id)}
                  title="Give this person show-driving authority"
                >
                  Make caller
                </button>
              )}
              {!isSelf && (
                <button
                  className="btn-sm btn-danger"
                  disabled={busy === r.user.id}
                  onClick={() => kick(r)}
                >
                  Kick
                </button>
              )}
            </div>
          );
        })}
      </div>

      {err && <div className="banner warn" style={{ marginTop: 10 }}>{err}</div>}

      <div className="crew-qr">
        <h4 className="panel-title" style={{ fontSize: 14, marginTop: 4 }}>
          Invite crew
        </h4>
        <QrCode />
      </div>
    </div>
  );
}
