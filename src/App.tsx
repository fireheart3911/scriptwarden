import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Bundle } from "./types";
import { timerElapsedMs } from "../shared/protocol";
import type { CodeAlert, CodeLevel, Role, RoomState, RosterEntry, UserPublic } from "../shared/protocol";
import { api } from "./api";
import { ws, useWs, type WsStatus } from "./ws";
import { getSession, setSession, clearSession, type Identity } from "./session";
import { Join } from "./views/Join";
import { ScriptEditor } from "./views/ScriptEditor";
import { CueSheet } from "./views/CueSheet";
import { ShowMode } from "./views/ShowMode";
import { SpotView } from "./views/SpotView";
import { Settings } from "./views/Settings";

type View = "script" | "cues" | "show" | "settings";
const TAB_LABEL: Record<View, string> = {
  script: "Script",
  cues: "Cue Sheet",
  show: "Show Mode",
  settings: "Settings",
};

// Role gates which tabs exist (§5.3). Operators + admins get the full editing
// surface; spot/viewer get only the show view. Admin is a superset (the host).
function tabsFor(role: Role, isAdmin: boolean): View[] {
  if (isAdmin || role === "caller" || role === "lights" || role === "audio")
    return ["script", "cues", "show", "settings"];
  return ["show"];
}

export function App() {
  const [identity, setIdentity] = useState<Identity | null>(getSession);
  const [notice, setNotice] = useState<string | null>(null);

  const onJoined = useCallback((id: Identity) => {
    setSession(id);
    setNotice(null);
    setIdentity(id);
  }, []);

  const onSignOut = useCallback((msg?: string) => {
    ws.disconnect();
    clearSession();
    setNotice(msg ?? null);
    setIdentity(null);
  }, []);

  if (!identity) return <Join onJoined={onJoined} notice={notice} />;
  return <Main key={identity.token} identity={identity} onSignOut={onSignOut} />;
}

function Main({
  identity,
  onSignOut,
}: {
  identity: Identity;
  onSignOut: (msg?: string) => void;
}) {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("show");
  const wsSnap = useWs();

  const reload = useCallback(async () => {
    try {
      setBundle(await api.bundle(identity.productionId));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [identity.productionId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Open the live connection for this identity. Torn down centrally in onSignOut
  // (kick / signed-in-elsewhere / manual), so no cleanup here — remounting on a
  // token change is handled by the key on <Main>.
  useEffect(() => {
    ws.connect(identity.token);
  }, [identity.token]);

  // Imperative WS side-effects: a kick or a dead/reused token returns us to Join;
  // a dataChanged (someone edited the script/cues) refetches the bundle.
  useEffect(() => {
    const offKick = ws.on("kicked", () =>
      onSignOut("You were removed from the show by an admin."),
    );
    const offUnauth = ws.on("unauthorized", () =>
      onSignOut("Signed out — your session ended, or you joined from another device."),
    );
    const offData = ws.on("dataChanged", () => reload());
    return () => {
      offKick();
      offUnauth();
      offData();
    };
  }, [reload, onSignOut]);

  const you: UserPublic | null = wsSnap.you;
  const role: Role = (you?.role ?? identity.role) as Role;
  const isAdmin = you?.is_admin ?? identity.isAdmin;
  const callerId = wsSnap.state?.callerUserId ?? null;
  const isCaller = !!you && you.id === callerId;

  const tabs = useMemo(() => tabsFor(role, isAdmin), [role, isAdmin]);
  // Keep the active view legal for the current role (e.g. a demoted operator).
  useEffect(() => {
    if (!tabs.includes(view)) setView(tabs[0]);
  }, [tabs, view]);

  const showOffline = wsSnap.status === "offline" && wsSnap.state != null;

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          Script<span>Warden</span>
        </div>
        <ConnectionDot status={wsSnap.status} />
        <ShowTimer state={wsSnap.state} canControl={isCaller || isAdmin} />
        <CodeButton code={wsSnap.state?.code ?? null} roster={wsSnap.roster} you={you} />
        <span className="spacer" />
        {bundle && (
          <div className="tabs">
            {tabs.map((t) => (
              <button
                key={t}
                className={"tab" + (view === t ? " active" : "")}
                onClick={() => setView(t)}
              >
                {TAB_LABEL[t]}
              </button>
            ))}
          </div>
        )}
        <RosterPopover
          roster={wsSnap.roster}
          you={you}
          callerId={callerId}
          identity={identity}
          readyCheckAt={wsSnap.state?.readyCheckAt ?? null}
          readyIds={wsSnap.state?.readyUserIds ?? []}
          canRunCheck={isCaller || isAdmin}
          onSignOut={() => onSignOut()}
        />
      </div>

      {showOffline && (
        <div className="offline-banner">● reconnecting — last position held</div>
      )}

      {wsSnap.state?.code && you && (
        <CodeBanner
          code={wsSnap.state.code}
          you={you}
          roster={wsSnap.roster}
          canClear={
            wsSnap.state.code.byUserId === you.id || isCaller || isAdmin
          }
        />
      )}

      {wsSnap.state?.readyCheckAt && you && (
        <ReadyBar
          readyIds={wsSnap.state.readyUserIds}
          you={you}
          roster={wsSnap.roster}
          canControl={isCaller || isAdmin}
        />
      )}

      <div
        className={view === "show" ? "" : "view"}
        style={view === "show" ? { flex: 1, overflow: "hidden" } : undefined}
      >
        {error && <div className="banner warn">{error}</div>}
        {!bundle && !error && <div className="empty">Loading…</div>}
        {bundle && view === "script" && <ScriptEditor bundle={bundle} reload={reload} />}
        {bundle && view === "cues" && <CueSheet bundle={bundle} reload={reload} />}
        {bundle &&
          view === "show" &&
          (role === "spot" ? (
            <SpotView bundle={bundle} identity={identity} />
          ) : (
            <ShowMode bundle={bundle} identity={identity} />
          ))}
        {bundle && view === "settings" && (
          <Settings bundle={bundle} reload={reload} onDeleted={() => onSignOut()} />
        )}
      </div>
    </div>
  );
}

function ConnectionDot({ status }: { status: WsStatus }) {
  const cls =
    status === "online" ? "dot-online" : status === "connecting" ? "dot-connecting" : "dot-offline";
  const label =
    status === "online"
      ? "Connected — live sync with the show server is active"
      : status === "connecting"
        ? "Connecting to the show server…"
        : "Offline — reconnecting automatically; your last position is held";
  // The padded wrapper carries the tooltip: an 11px dot alone is a hopeless
  // hover target on a booth laptop, let alone a phone.
  return (
    <span className="conn-wrap" title={label} aria-label={label}>
      <span className={"conn-dot dot " + cls} />
    </span>
  );
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// mm:ss for short countdowns, HH:MM:SS beyond an hour.
function fmtCountdown(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s >= 3600) return fmtElapsed(ms);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function ShowTimer({
  state,
  canControl,
}: {
  state: RoomState | null;
  canControl: boolean;
}) {
  // One shared 1s tick drives the wall clock, the elapsed display and the
  // resume countdown.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Stopped = the clock is frozen at the final runtime (timerStartedAt is kept
  // so the elapsed formula still works); running means live-and-not-stopped.
  const stopped = !!state?.timerStoppedAt;
  const running = !!state?.timerStartedAt && !stopped;
  const paused = running && !!state?.timerPausedAt;
  const elapsed = state ? timerElapsedMs(state, now) : 0;
  const resumeAt = paused ? state?.timerResumeAt ?? null : null;
  const resumeIn = resumeAt ? Date.parse(resumeAt) - now : null;
  // Pre-show countdown (only meaningful while the timer isn't running).
  const showAt = !running ? state?.showAt ?? null : null;
  const showIn = showAt ? Date.parse(showAt) - now : null;

  const pause = () => {
    const v = prompt(
      "Pause the show timer.\nOptional: minutes until the show resumes (shown to everyone as a countdown). Leave blank for open-ended.",
      "",
    );
    if (v === null) return;
    const min = parseFloat(v.replace(",", "."));
    ws.send({
      type: "showPause",
      ...(Number.isFinite(min) && min > 0 ? { resumeInSec: Math.round(min * 60) } : {}),
    });
  };

  // Paused WITH a countdown: the time-left REPLACES the show clock (that's the
  // number everyone actually needs during an interval). Paused without one:
  // frozen elapsed + a "paused" hint. Stopped: the FINAL time stays frozen on
  // the clock (until cleared / the next start) — unless a new pre-show
  // countdown takes the slot. Not running + pre-show countdown: time to
  // showtime takes the clock slot.
  const clockText = !running
    ? showIn !== null
      ? `⏳ ${showIn > 0 ? fmtCountdown(showIn) : "SHOWTIME"}`
      : stopped
        ? `■ ${fmtElapsed(elapsed)}`
        : "––:––:––"
    : paused && resumeIn !== null
      ? `⏸ ${resumeIn > 0 ? fmtCountdown(resumeIn) : "0:00"}`
      : (paused ? "⏸ " : "") + fmtElapsed(elapsed);

  const setCountdown = () => {
    const v = prompt(
      "When does the show start? (shown to everyone as a countdown)\n" +
        "Enter a clock time like 19:30, or minutes from now like 15.\nLeave blank to clear.",
      "",
    );
    if (v === null) return;
    const s = v.trim();
    let inSec: number | null = null;
    const hm = s.match(/^(\d{1,2}):(\d{2})$/);
    if (hm && Number(hm[1]) < 24 && Number(hm[2]) < 60) {
      // Clock time — today at hh:mm; if that already passed, tomorrow.
      const target = new Date();
      target.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
      if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
      inSec = Math.round((target.getTime() - Date.now()) / 1000);
    } else {
      const min = parseFloat(s.replace(",", "."));
      if (Number.isFinite(min) && min > 0) inSec = Math.round(min * 60);
    }
    ws.send({ type: "showCountdown", inSec });
  };

  return (
    <div className="show-timer" title="Show timer">
      <span
        className={
          "timer-clock" +
          (running && !paused ? " running" : "") +
          (paused ? " paused" : "") +
          (showIn !== null ? " preshow" : "")
        }
        title={
          paused && resumeIn !== null
            ? "Time until the show resumes"
            : showIn !== null
              ? "Time until the show starts"
              : stopped
                ? "Final show time (stopped)"
                : "Show timer"
        }
      >
        {clockText}
      </span>
      {paused && (
        <span className="resume-hint">
          {resumeIn === null ? "paused" : resumeIn > 0 ? "until resume" : "resuming now"}
        </span>
      )}
      {stopped && showIn === null && <span className="resume-hint">final</span>}
      {showIn !== null && showIn > 0 && <span className="resume-hint">to showtime</span>}
      <span className="wall-clock" title="Time of day">
        {new Date(now).toLocaleTimeString([], { hour12: false })}
      </span>
      {canControl &&
        (running ? (
          <>
            {paused ? (
              <button className="btn-sm timer-start" onClick={() => ws.send({ type: "showResume" })}>
                ▶ Resume
              </button>
            ) : (
              <button className="btn-sm" onClick={pause}>
                ⏸ Pause
              </button>
            )}
            <button
              className="btn-sm"
              title="Freeze the clock at the final time (it stays on screen until cleared)"
              onClick={() => confirm("Stop the show timer?") && ws.send({ type: "showStop" })}
            >
              ■ Stop
            </button>
          </>
        ) : (
          <>
            <button
              className="btn-sm timer-start"
              onClick={() =>
                (!stopped || confirm("Start a new show? The stopped final time will be discarded.")) &&
                ws.send({ type: "showStart" })
              }
            >
              ▶ Start show
            </button>
            <button
              className="btn-sm"
              onClick={setCountdown}
              title="Set / clear the pre-show countdown everyone sees"
            >
              ⏳
            </button>
            {stopped && (
              <button
                className="btn-sm"
                title="Clear the stopped timer back to ––:––:––"
                onClick={() => ws.send({ type: "timerClear" })}
              >
                ✕
              </button>
            )}
          </>
        ))}
    </div>
  );
}

// The crew-wide ready check: everyone gets a bar with one big button; the
// caller/admin sees who is still missing and can end the check.
function ReadyBar({
  readyIds,
  you,
  roster,
  canControl,
}: {
  readyIds: number[];
  you: UserPublic;
  roster: RosterEntry[];
  canControl: boolean;
}) {
  const meReady = readyIds.includes(you.id);
  const online = roster.filter((r) => r.online);
  const readyCount = online.filter((r) => readyIds.includes(r.user.id)).length;
  const waiting = online.filter((r) => !readyIds.includes(r.user.id)).map((r) => r.user.name);
  const allReady = online.length > 0 && waiting.length === 0;
  return (
    <div className={"ready-bar" + (allReady ? " all" : "")}>
      <b className="ready-title">READY CHECK</b>
      <span className="ready-count">
        {readyCount}/{online.length} ready{allReady ? " — all set! 🎭" : ""}
      </span>
      {!allReady && waiting.length > 0 && (
        <span className="ready-waiting">waiting: {waiting.join(", ")}</span>
      )}
      <span className="spacer" />
      {meReady ? (
        <span className="ready-done">✓ you're ready</span>
      ) : (
        <button className="ready-btn" onClick={() => ws.send({ type: "ready" })}>
          I'M READY ✓
        </button>
      )}
      {canControl && (
        <button
          className="btn-ghost btn-sm"
          onClick={() => ws.send({ type: "readyCheck", action: "stop" })}
        >
          End check
        </button>
      )}
    </div>
  );
}

// The active code as a full-width banner. Everyone receives the code over WS;
// only the addressed device(s) — everyone when targetUserId is null — plus the
// raiser (as confirmation) actually display it.
function CodeBanner({
  code,
  you,
  roster,
  canClear,
}: {
  code: CodeAlert;
  you: UserPublic;
  roster: RosterEntry[];
  canClear: boolean;
}) {
  const forMe = code.targetUserId === null || code.targetUserId === you.id;
  const mine = code.byUserId === you.id;
  if (!forMe && !mine) return null;
  const targetName =
    code.targetUserId !== null
      ? roster.find((r) => r.user.id === code.targetUserId)?.user.name ?? "one crew member"
      : null;
  return (
    <div className={`code-bar code-${code.level}`}>
      <b className="code-title">
        ⚠ CODE {code.level.toUpperCase()}
      </b>
      {code.msg && <span className="code-msg">{code.msg}</span>}
      <span className="code-meta">
        by {code.byName}
        {targetName ? (mine && !forMe ? ` → ${targetName}` : " → you") : " → everyone"}
      </span>
      <span className="spacer" />
      {canClear && (
        <button
          className="code-clear"
          onClick={() => confirm(`Clear CODE ${code.level.toUpperCase()}? (situation resolved)`) && ws.send({ type: "codeClear" })}
        >
          ALL CLEAR ✓
        </button>
      )}
    </div>
  );
}

// Topbar "⚠" button: raise a code — pick a level, optionally a message and a
// single recipient. Available to every role: a spot op on a catwalk sees
// things the booth can't.
function CodeButton({
  code,
  roster,
  you,
}: {
  code: CodeAlert | null;
  roster: RosterEntry[];
  you: UserPublic | null;
}) {
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<CodeLevel>("yellow");
  const [msg, setMsg] = useState("");
  const [target, setTarget] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!you) return null;
  const others = roster.filter((r) => r.user.id !== you.id);

  const send = () => {
    ws.send({
      type: "codeRaise",
      level,
      ...(msg.trim() ? { msg: msg.trim() } : {}),
      ...(target !== null ? { targetUserId: target } : {}),
    });
    setMsg("");
    setTarget(null);
    setOpen(false);
  };

  return (
    <div className="code-wrap" ref={ref}>
      <button
        className={"code-btn" + (code ? ` active code-${code.level}` : "")}
        title={code ? `CODE ${code.level.toUpperCase()} is active` : "Raise a code (alert the team)"}
        onClick={() => setOpen((v) => !v)}
      >
        ⚠
      </button>
      {open && (
        <div className="code-pop">
          <div className="hint" style={{ marginBottom: 6 }}>
            Raise a code — alert one person or the whole team.
          </div>
          <div className="row" style={{ gap: 6, marginBottom: 8 }}>
            {(["yellow", "red"] as CodeLevel[]).map((l) => (
              <button
                key={l}
                className={`code-level code-${l}` + (level === l ? " active" : "")}
                onClick={() => setLevel(l)}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </div>
          <select
            value={target ?? 0}
            onChange={(e) => setTarget(Number(e.target.value) || null)}
            style={{ width: "100%", marginBottom: 8 }}
          >
            <option value={0}>Everyone</option>
            {others.map((r) => (
              <option key={r.user.id} value={r.user.id}>
                {r.user.name} ({r.user.role}
                {r.online ? "" : " · offline"})
              </option>
            ))}
          </select>
          <input
            value={msg}
            placeholder="What's going on? (optional)"
            maxLength={200}
            style={{ width: "100%", marginBottom: 8 }}
            onChange={(e) => setMsg(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
          />
          <button className={`code-send code-${level}`} onClick={send}>
            SEND CODE {level.toUpperCase()}
          </button>
        </div>
      )}
    </div>
  );
}

function RosterPopover({
  roster,
  you,
  callerId,
  identity,
  readyCheckAt,
  readyIds,
  canRunCheck,
  onSignOut,
}: {
  roster: RosterEntry[];
  you: UserPublic | null;
  callerId: number | null;
  identity: Identity;
  readyCheckAt: string | null;
  readyIds: number[];
  canRunCheck: boolean;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const online = roster.filter((r) => r.online).length;
  const myName = you?.name ?? identity.name;

  return (
    <div className="roster-wrap" ref={ref}>
      <button className="roster-btn" onClick={() => setOpen((v) => !v)}>
        <span className="roster-me">{myName}</span>
        <span className="roster-count">
          {online}/{roster.length} online
        </span>
      </button>
      {open && (
        <div className="roster-pop">
          <div className="roster-head hint">Crew</div>
          {roster.length === 0 && <div className="muted roster-empty">No crew yet.</div>}
          {roster.map((r) => (
            <div key={r.user.id} className="roster-row">
              <span className={"dot " + (r.online ? "dot-online" : "dot-offline")} />
              <span className="roster-name">{r.user.name}</span>
              <span className="roster-role">{r.user.role}</span>
              {callerId === r.user.id && <span className="badge badge-caller">CALLER</span>}
              {readyCheckAt && (
                <span className={"ready-mark" + (readyIds.includes(r.user.id) ? " ok" : "")}>
                  {readyIds.includes(r.user.id) ? "✓" : "…"}
                </span>
              )}
            </div>
          ))}
          <div className="roster-foot">
            {canRunCheck && !readyCheckAt && (
              <button
                className="btn-sm"
                onClick={() => ws.send({ type: "readyCheck", action: "start" })}
                title="Ask every crew member to confirm they're ready"
              >
                ✓ Ready check
              </button>
            )}
            <button className="btn-ghost btn-sm" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
