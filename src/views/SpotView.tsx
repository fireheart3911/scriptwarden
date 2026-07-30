import { useEffect, useMemo, useRef, useState } from "react";
import type { Bundle, Cue } from "../types";
import type { S2C } from "../../shared/protocol";
import { buildOrder, type OrderEntry } from "../../shared/runningOrder";
import { deptCues, resolvePosIdx, spotCueFor } from "../../shared/showSync";
import { ws, useWs } from "../ws";
import type { Identity } from "../session";

interface Props {
  bundle: Bundle;
  identity: Identity;
}

// SpotView (§5.3) — the input-less spot operator screen. NO fired state: the
// ACTIVE card is the last spot cue at/before the global position, the STANDBY is
// the first after. Huge type, minimal chrome, green flash on ACTIVE change, a
// screen wake-lock, and always "engaged" (it can't disengage). Offline keeps the
// last cards on screen with a banner — the operator must never lose their pickup.
const THEME_KEY = "scriptwarden.spotTheme";

export function SpotView({ bundle, identity }: Props) {
  const { lines, sections, cues } = bundle;
  const { you, state, status } = useWs();
  const spotNo = you?.spot_no ?? identity.spotNo ?? 0;

  // Light/dark toggle (per device): followspot positions vary — a lit catwalk
  // wants a bright screen, a dark booth wants the AMOLED black default.
  const [light, setLight] = useState(() => {
    try {
      return localStorage.getItem(THEME_KEY) === "light";
    } catch {
      return false;
    }
  });
  const toggleTheme = () =>
    setLight((v) => {
      const next = !v;
      try {
        localStorage.setItem(THEME_KEY, next ? "light" : "dark");
      } catch {
        /* private mode — theme just won't persist */
      }
      return next;
    });

  const order = useMemo(() => buildOrder(lines, sections, cues), [lines, sections, cues]);
  const pos = state?.position ?? { key: "", idx: 0 };
  const posIdx = useMemo(() => resolvePosIdx(order, pos.key, pos.idx), [order, pos.key, pos.idx]);

  // A stop matters to this spot when it carries a spot cue for them — OR when
  // it is a PAUSE event (interval/hold): spot ops see pauses as cues too, so
  // they always know a break is coming / running.
  const isSpotStop = useMemo(
    () => (e: OrderEntry) =>
      deptCues(e, "spot", spotNo).length > 0 || e.line.type === "pause",
    [spotNo],
  );

  // ACTIVE: last matching stop at/before position; NEXT: first strictly after;
  // PREVIOUS: last strictly before the active one — context for "what did I
  // just come from" (e.g. after a missed pickup or a reconnect).
  const activeIdx = useMemo(() => {
    let found = -1;
    for (let i = 0; i <= Math.min(posIdx, order.length - 1); i++) {
      if (isSpotStop(order[i])) found = i;
    }
    return found;
  }, [order, isSpotStop, posIdx]);
  const standbyIdx = useMemo(() => {
    for (let i = Math.max(0, posIdx + 1); i < order.length; i++) {
      if (isSpotStop(order[i])) return i;
    }
    return -1;
  }, [order, isSpotStop, posIdx]);
  const prevIdx = useMemo(() => {
    for (let i = activeIdx - 1; i >= 0; i--) {
      if (isSpotStop(order[i])) return i;
    }
    return -1;
  }, [order, isSpotStop, activeIdx]);

  const active = activeIdx >= 0 ? order[activeIdx] : undefined;
  const standby = standbyIdx >= 0 ? order[standbyIdx] : undefined;
  const prev = prevIdx >= 0 ? order[prevIdx] : undefined;
  const activeCue: Cue | undefined = active ? spotCueFor(active, spotNo) : undefined;
  const standbyCue: Cue | undefined = standby ? spotCueFor(standby, spotNo) : undefined;
  const prevCue: Cue | undefined = prev ? spotCueFor(prev, spotNo) : undefined;
  const standbyIn = standby ? Math.max(0, standbyIdx - posIdx) : 0;

  // Green flash on ACTIVE change or on a spotFlash addressed to us (§6 test).
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevActiveKey = useRef<string | null>(null);
  const pulse = () => {
    setFlash(true);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(false), 750);
  };

  useEffect(() => {
    const k = active?.key ?? null;
    if (prevActiveKey.current !== null && k !== prevActiveKey.current && k !== null) pulse();
    prevActiveKey.current = k;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.key]);

  useEffect(() => {
    const off = ws.on("spotFlash", (p) => {
      const m = p as Extract<S2C, { type: "spotFlash" }>;
      if (m.target === 0 || m.target === spotNo) pulse();
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotNo]);

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );

  // Screen wake-lock (guard availability + re-acquire on visibility) so the phone
  // never sleeps mid-show. Fails silently on unsupported browsers.
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const request = async () => {
      try {
        const nav = navigator as Navigator & {
          wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> };
        };
        if (nav.wakeLock && document.visibilityState === "visible") {
          lock = await nav.wakeLock.request("screen");
        }
      } catch {
        /* denied / unsupported — no-op */
      }
    };
    request();
    const onVis = () => {
      if (document.visibilityState === "visible") request();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      try {
        lock?.release();
      } catch {
        /* already released */
      }
    };
  }, []);

  const offline = status === "offline";

  return (
    <div className={"spotview" + (light ? " light" : "") + (flash ? " flash" : "")}>
      <button
        className="spot-theme-toggle"
        onClick={toggleTheme}
        title={light ? "Switch to dark mode" : "Switch to light mode"}
      >
        {light ? "🌙 Dark" : "☀️ Light"}
      </button>
      {offline && (
        <div className="spot-offline">● reconnecting — showing last instruction</div>
      )}
      <div className="spot-cards">
        <div className="spot-card prev">
          <div className="spot-eyebrow">PREVIOUS</div>
          {prevCue ? (
            <SpotCue cue={prevCue} muted compact />
          ) : prev ? (
            <PauseCard entry={prev} compact />
          ) : (
            <div className="spot-idle">No previous cue.</div>
          )}
        </div>

        <div className="spot-card active">
          <div className="spot-eyebrow">
            ACTIVE{spotNo ? ` · Spot ${spotNo}` : ""}
          </div>
          {activeCue ? (
            <SpotCue cue={activeCue} />
          ) : active ? (
            <PauseCard entry={active} />
          ) : (
            <div className="spot-idle">Standing by — no active cue yet.</div>
          )}
        </div>

        <div className="spot-card standby">
          <div className="spot-eyebrow">
            NEXT{standby ? ` · in ${standbyIn} line${standbyIn === 1 ? "" : "s"}` : ""}
          </div>
          {standbyCue ? (
            <SpotCue cue={standbyCue} muted />
          ) : standby ? (
            <PauseCard entry={standby} muted />
          ) : (
            <div className="spot-idle">No further spot cues.</div>
          )}
        </div>
      </div>
    </div>
  );
}

// A PAUSE event rendered like a cue: spot ops see intervals/holds in their
// prev/active/next stream ("douse, break coming"). Sections show the pause's
// inner step (Break start / Loop / Warning / End).
function PauseCard({ entry, muted, compact }: { entry: OrderEntry; muted?: boolean; compact?: boolean }) {
  const name = entry.line.text?.trim() || "Pause";
  const step = entry.kind === "section" ? entry.section?.label?.trim() : "";
  if (compact) {
    return <div className="spot-compact">⏸ {name}{step ? ` · ${step}` : ""}</div>;
  }
  return (
    <div className={"spot-instr" + (muted ? " muted-card" : "")}>
      <div className="spot-target spot-pause">⏸ PAUSE</div>
      <div className="spot-label">
        {name}
        {step ? ` — ${step}` : ""}
      </div>
    </div>
  );
}

// One spot instruction, stacked huge: TARGET / PICKUP / COLOR / SIZE + notes.
// `compact` renders the PREVIOUS card's one-line summary instead of the stack.
function SpotCue({ cue, muted, compact }: { cue: Cue; muted?: boolean; compact?: boolean }) {
  const target = cue.spot_target ? `Spot ${cue.spot_target}` : "All spots";
  const rows: { k: string; v: string }[] = [];
  if (cue.spot_pickup) rows.push({ k: "PICK UP", v: cue.spot_pickup });
  if (cue.spot_color) rows.push({ k: "COLOR", v: cue.spot_color });
  if (cue.spot_size) rows.push({ k: "SIZE", v: cue.spot_size });
  if (compact) {
    const bits = [target, cue.label, ...rows.map((r) => `${r.k} ${r.v}`)].filter(Boolean);
    return <div className="spot-compact">{bits.join(" · ")}</div>;
  }
  return (
    <div className={"spot-instr" + (muted ? " muted-card" : "")}>
      <div className="spot-target">{target}</div>
      {cue.label ? <div className="spot-label">{cue.label}</div> : null}
      {rows.length > 0 ? (
        <div className="spot-rows">
          {rows.map((r) => (
            <div key={r.k} className="spot-row">
              <span className="spot-row-k">{r.k}</span>
              <span className="spot-row-v">{r.v}</span>
            </div>
          ))}
        </div>
      ) : (
        !cue.label && <div className="spot-idle">Pick up as marked.</div>
      )}
      {cue.notes ? <div className="spot-notes">{cue.notes}</div> : null}
    </div>
  );
}
