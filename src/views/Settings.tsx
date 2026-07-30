import { useState } from "react";
import type { Bundle } from "../types";
import { api } from "../api";
import { parseShowSettings, type ShowSettings } from "../lib/showSettings";
import { useWs } from "../ws";
import { CrewPanel } from "../components/CrewPanel";

interface Props {
  bundle: Bundle;
  reload: () => void;
  onDeleted: () => void;
}

export function Settings({ bundle, reload, onDeleted }: Props) {
  const p = bundle.production;
  const live = !!p.osc_enabled && !!p.osc_ip;
  const { you } = useWs();
  const isAdmin = !!you?.is_admin;

  const show = parseShowSettings(p);
  const saveShow = (patch: Partial<ShowSettings>) => {
    const next: ShowSettings = { ...show, ...patch };
    api.patchProduction(p.id, { settings: JSON.stringify(next) }).then(reload);
  };

  // First-run guidance: shown to the admin until a console is configured (the
  // app is fully usable without one — cues just log instead of transmitting).
  const noConsoleYet = !p.osc_ip && !p.avantis_ip;

  return (
    <div>
      {isAdmin && noConsoleYet && (
        <div className="panel">
          <h3 className="panel-title">Getting started</h3>
          <ol className="hint" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
            <li>Paste your script in the <b>Script</b> tab — it's auto-classified into dialogue, songs and scenes.</li>
            <li>Add cues to lines/sections (lights, audio, followspots). Everything works <b>without any console</b>: firing is stub/log-only until you enable live send below.</li>
            <li>Crew joins from their own devices — the <b>Crew</b> panel above shows the join URL as a QR code.</li>
            <li>When you have hardware: configure the console connection(s) below, <b>test against a simulator first</b> (ETCnomad, or <code>bun scripts/fake-eos.ts</code> / <code>fake-avantis.ts</code>), then tick "Enable live send".</li>
          </ol>
        </div>
      )}
      {isAdmin && <CrewPanel />}
      {isAdmin && <SessionPinPanel pin={p.join_pin} productionId={p.id} reload={reload} />}

      <div className="panel">
        <h3 className="panel-title">Production</h3>
        <label className="hint">Name</label>
        <input
          defaultValue={p.name}
          style={{ width: 320, display: "block", marginBottom: 12 }}
          onBlur={(e) => e.target.value !== p.name && api.patchProduction(p.id, { name: e.target.value }).then(reload)}
        />
        <label className="hint">Production notes</label>
        <textarea
          rows={4}
          defaultValue={p.notes}
          onBlur={(e) => e.target.value !== p.notes && api.patchProduction(p.id, { notes: e.target.value }).then(reload)}
        />
        <div style={{ marginTop: 12 }}>
          <label className="hint">Followspots (1–9)</label>
          <input
            type="number"
            min={1}
            max={9}
            defaultValue={show.spotCount}
            style={{ display: "block", width: 100 }}
            onBlur={(e) => {
              const v = Math.min(9, Math.max(1, Math.floor(Number(e.target.value) || 0)));
              if (v !== show.spotCount) saveShow({ spotCount: v });
            }}
          />
          <p className="hint" style={{ marginTop: 6 }}>
            How many followspots this show runs — sets the targets offered when editing spot cues
            and the spot numbers on the Join screen.
          </p>
        </div>
        <div style={{ marginTop: 12 }}>
          <label className="hint">Backup</label>
          <div>
            <a className="btn-sm" href={api.exportUrl(p.id)} download>
              Export show (JSON)
            </a>
          </div>
          <p className="hint" style={{ marginTop: 6 }}>
            Downloads this production, its characters, lines, song sections (with lyrics) and cues
            as a single JSON file.
          </p>
        </div>
      </div>

      <div className="panel">
        <h3 className="panel-title">Show Mode — smart settings</h3>
        <div style={{ marginBottom: 12 }}>
          <label className="hint">GO guard distance (0 = off)</label>
          <input
            type="number"
            min={0}
            defaultValue={show.goGuard}
            style={{ display: "block", width: 100 }}
            onBlur={(e) => {
              const v = Math.max(0, Math.floor(Number(e.target.value) || 0));
              if (v !== show.goGuard) saveShow({ goGuard: v });
            }}
          />
          <p className="hint" style={{ marginTop: 6 }}>
            Block GO when the armed cue is more than <i>n</i> items ahead — Shift+GO overrides.
          </p>
        </div>
        <label className="row" style={{ gap: 8, marginBottom: 6 }}>
          <input
            type="checkbox"
            checked={show.exitFire}
            onChange={(e) => saveShow({ exitFire: e.target.checked })}
          />
          <span>→ exiting a loop also fires the next cue</span>
        </label>
        <label className="row" style={{ gap: 8, marginBottom: 6 }}>
          <input
            type="checkbox"
            checked={show.autoExec}
            onChange={(e) => saveShow({ autoExec: e.target.checked })}
          />
          <span>forward arrows fire the non-loop cues they pass</span>
        </label>
        <label className="row" style={{ gap: 8, marginBottom: 6 }}>
          <input
            type="checkbox"
            checked={show.followGo}
            onChange={(e) => saveShow({ followGo: e.target.checked })}
          />
          <span>GO moves your reading position to just after the fired cue</span>
        </label>
        <label className="row" style={{ gap: 8, marginBottom: 6 }}>
          <input
            type="checkbox"
            checked={show.scrollArmed}
            onChange={(e) => saveShow({ scrollArmed: e.target.checked })}
          />
          <span>briefly scroll the armed cue into view when it changes</span>
        </label>
        <label className="row" style={{ gap: 8 }}>
          <input
            type="checkbox"
            checked={show.rewindRearm}
            onChange={(e) => saveShow({ rewindRearm: e.target.checked })}
          />
          <span>rewinding the caller position re-arms fired cues at/after it (v1 default)</span>
        </label>
      </div>

      {isAdmin && (
      <div className="panel">
        <h3 className="panel-title">Lighting console — ETC Eos family (OSC)</h3>
        <p className="hint" style={{ marginTop: 0 }}>
          Works with any Eos-family console (Ion / Ion Xe, Element, Gio, Ti, Apex) and with{" "}
          <b>ETCnomad</b> on a PC — the fire path speaks Eos OSC (<code>/eos/…</code>). Other
          lighting desks are not supported for live firing yet; without a console everything
          still runs in stub mode (cues are logged, nothing transmits).
        </p>
        {live ? (
          <div className="banner live">Live send is ON — GO will transmit to the console.</div>
        ) : (
          <div className="banner warn">
            Live send is OFF — messages are logged only. Turn it on once you can test against the console or ETCnomad.
          </div>
        )}
        <div className="row wrap" style={{ marginBottom: 12 }}>
          <div>
            <label className="hint">Console IP</label>
            <input
              defaultValue={p.osc_ip}
              placeholder="10.101.90.101"
              style={{ display: "block", width: 180 }}
              onBlur={(e) => e.target.value !== p.osc_ip && api.patchProduction(p.id, { osc_ip: e.target.value }).then(reload)}
            />
          </div>
          <div>
            <label className="hint">Port</label>
            <input
              type="number"
              defaultValue={p.osc_port}
              style={{ display: "block", width: 100 }}
              onBlur={(e) => Number(e.target.value) !== p.osc_port && api.patchProduction(p.id, { osc_port: Number(e.target.value) }).then(reload)}
            />
          </div>
          <div>
            <label className="hint">Protocol</label>
            <select
              defaultValue={p.osc_protocol}
              style={{ display: "block" }}
              onChange={(e) => api.patchProduction(p.id, { osc_protocol: e.target.value as "udp" | "tcp" }).then(reload)}
            >
              <option value="udp">UDP (RX default 8000)</option>
              <option value="tcp">TCP (default 3032)</option>
            </select>
          </div>
        </div>
        <label className="row" style={{ gap: 8 }}>
          <input
            type="checkbox"
            checked={!!p.osc_enabled}
            onChange={(e) => api.patchProduction(p.id, { osc_enabled: (e.target.checked ? 1 : 0) as any }).then(reload)}
          />
          <span>Enable live send (transmit OSC to the console)</span>
        </label>
        <p className="hint" style={{ marginTop: 8 }}>
          On the console: <b>Setup → System → Show Control → OSC</b> — enable “OSC RX” and set the
          UDP RX port to match (default 8000; TCP uses 3032). Tip: test against <b>ETCnomad</b> in
          demo mode on this machine before opening night, and try <code>bun scripts/fake-eos.ts</code>{" "}
          to exercise the live cue mirror with no hardware at all.
        </p>
      </div>
      )}

      {isAdmin && <AvantisPanel bundle={bundle} reload={reload} />}

      {!isAdmin && (
        <div className="panel">
          <h3 className="panel-title">Console connections</h3>
          <p className="hint">
            The lighting (OSC) and audio (MIDI) console connections, the session PIN and crew
            management are managed by the show admin — the first device that joined this
            production.
          </p>
        </div>
      )}

      {isAdmin && (
        <div className="panel">
          <h3 className="panel-title" style={{ color: "var(--danger)" }}>Danger zone</h3>
          <button
            className="btn-danger"
            onClick={() => {
              if (confirm(`Delete "${p.name}" and all its lines, cues and notes? This cannot be undone.`)) {
                api.deleteProduction(p.id).then(onDeleted);
              }
            }}
          >
            Delete production
          </button>
        </div>
      )}
    </div>
  );
}

// Admin-only: the session join PIN. Empty = anyone on the network can join.
function SessionPinPanel({
  pin,
  productionId,
  reload,
}: {
  pin: string;
  productionId: number;
  reload: () => void;
}) {
  return (
    <div className="panel">
      <h3 className="panel-title">Session PIN</h3>
      {pin ? (
        <div className="banner live">PIN required to join — new devices must enter it on the Join screen.</div>
      ) : (
        <div className="banner warn">No PIN set — anyone on the network can join this show.</div>
      )}
      <label className="hint">Join PIN (blank = open)</label>
      <input
        defaultValue={pin}
        placeholder="e.g. 4207"
        inputMode="numeric"
        style={{ display: "block", width: 180 }}
        onBlur={(e) =>
          e.target.value !== pin &&
          api.patchProduction(productionId, { join_pin: e.target.value }).then(reload)
        }
      />
      <p className="hint" style={{ marginTop: 6 }}>
        Already-joined devices keep working when the PIN changes — it is only checked at join.
        To lock someone out, kick them in the Crew panel after changing the PIN.
      </p>
    </div>
  );
}

// Admin-only: Avantis (audio console) MIDI-over-TCP connection + scene test-fire.
function AvantisPanel({ bundle, reload }: { bundle: Bundle; reload: () => void }) {
  const p = bundle.production;
  const live = !!p.avantis_enabled && !!p.avantis_ip;
  const [testScene, setTestScene] = useState(1);
  const [testResult, setTestResult] = useState<string | null>(null);

  async function testFire() {
    setTestResult(null);
    try {
      const entry = await api.avantisTest(p.id, testScene);
      setTestResult(`${entry.sent ? "SENT" : "STUB"} — ${entry.preview}`);
    } catch (e) {
      setTestResult(String(e));
    }
  }

  return (
    <div className="panel">
      <h3 className="panel-title">Audio console — scene recall (MIDI over TCP)</h3>
      <p className="hint" style={{ marginTop: 0 }}>
        Built for the <b>Allen &amp; Heath Avantis</b>; dLive and SQ use the same MIDI-over-TCP
        scheme (port 51325), and any desk that accepts Bank Select + Program Change over a plain
        TCP socket should work. MIDI over USB/DIN is not supported — the desk must be reachable
        over the network.
      </p>
      {live ? (
        <div className="banner live">Live send is ON — audio GO will transmit MIDI to the desk.</div>
      ) : (
        <div className="banner warn">
          Live send is OFF — audio cues are logged only. Test with <code>bun scripts/fake-avantis.ts</code> before the real desk.
        </div>
      )}
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <div>
          <label className="hint">Desk IP</label>
          <input
            defaultValue={p.avantis_ip}
            placeholder="e.g. 10.101.100.120"
            style={{ display: "block", width: 180 }}
            onBlur={(e) =>
              e.target.value !== p.avantis_ip &&
              api.patchProduction(p.id, { avantis_ip: e.target.value }).then(reload)
            }
          />
        </div>
        <div>
          <label className="hint">Port</label>
          <input
            type="number"
            defaultValue={p.avantis_port}
            style={{ display: "block", width: 100 }}
            onBlur={(e) =>
              Number(e.target.value) !== p.avantis_port &&
              api.patchProduction(p.id, { avantis_port: Number(e.target.value) }).then(reload)
            }
          />
        </div>
        <div>
          <label className="hint">Base MIDI channel (1–16)</label>
          <input
            type="number"
            min={1}
            max={16}
            defaultValue={p.avantis_channel}
            style={{ display: "block", width: 100 }}
            onBlur={(e) =>
              Number(e.target.value) !== p.avantis_channel &&
              api.patchProduction(p.id, { avantis_channel: Number(e.target.value) }).then(reload)
            }
          />
        </div>
      </div>
      <label className="row" style={{ gap: 8, marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={!!p.avantis_enabled}
          onChange={(e) =>
            api.patchProduction(p.id, { avantis_enabled: (e.target.checked ? 1 : 0) as any }).then(reload)
          }
        />
        <span>Enable live send (transmit MIDI to the desk)</span>
      </label>
      <div className="row" style={{ gap: 8 }}>
        <label className="hint" style={{ alignSelf: "center" }}>Test scene</label>
        <input
          type="number"
          min={1}
          max={500}
          value={testScene}
          style={{ width: 90 }}
          onChange={(e) => setTestScene(Math.trunc(Number(e.target.value) || 1))}
        />
        <button className="btn-sm" onClick={testFire}>Test recall</button>
        {testResult && <span className="hint" style={{ alignSelf: "center" }}>{testResult}</span>}
      </div>
      <p className="hint" style={{ marginTop: 8 }}>
        On the desk: <b>Utility → Shows/MIDI</b> — match the base MIDI channel. The desk listens
        for MIDI over TCP on port 51325. Scene recall sends Bank Select + Program Change
        (e.g. scene 264 → <code>B0 00 02 C0 07</code>).
      </p>
    </div>
  );
}
