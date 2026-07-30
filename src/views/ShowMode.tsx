import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Bundle, Cue, Department, ScriptLine } from "../types";
import type { EosActiveCue, FireLogEntry, S2C } from "../../shared/protocol";
import { api } from "../api";
import {
  buildOrder,
  currentSceneStart,
  landmarkIndices,
  nextLandmark,
  prevLandmark,
  sceneStartIndices,
  type OrderEntry,
} from "../../shared/runningOrder";
import {
  computeArmed,
  deptCues,
  deptStops,
  isLoopStop,
  resolvePosIdx,
  type FiringDept,
} from "../../shared/showSync";
import { buildCuePreview } from "../lib/preview";
import { parseShowSettings } from "../lib/showSettings";
import { tint } from "../lib/colors";
import { ws, useWs } from "../ws";
import type { Identity } from "../session";

interface Props {
  bundle: Bundle;
  identity: Identity;
}

// A fired-log row: a fire entry tagged with the department that fired it, so the
// panel can render [LX]/[AUD]/[SPOT] across all departments.
type LogItem = FireLogEntry & { dept: Department };

const DEPT_TAG: Record<Department, string> = { lights: "LX", audio: "AUD", spot: "SPOT" };
const LENS_KEY = "scriptwarden.deptLens";
const HIDE_SD_KEY = "scriptwarden.hideStageDirs";

// Await the next `fired`/`rearmed` matching `pred` (or an error / timeout → null).
// Used by the solo-mode smart-arrow chain to sequence server-authoritative fires:
// each GO's expectedKey depends on the previous fire being applied to the mirror.
function waitWsEvent(
  evt: "fired" | "rearmed",
  pred: (m: any) => boolean,
  timeout = 2000,
): Promise<any | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: any) => {
      if (settled) return;
      settled = true;
      offEvt();
      offErr();
      clearTimeout(timer);
      resolve(v);
    };
    const offEvt = ws.on(evt, (p) => {
      if (pred(p)) finish(p);
    });
    const offErr = ws.on("error", () => finish(null));
    const timer = setTimeout(() => finish(null), timeout);
  });
}

function errorText(code: string, msg: string): string {
  switch (code) {
    case "guarded":
      return "Blocked — cue is far ahead. Shift+GO to override.";
    case "stale":
      return "Re-synced — the armed cue had moved.";
    case "locked":
      return "Already firing…";
    case "bad_dept":
      return msg || "You don't operate that department.";
    case "not_caller":
      return msg || "Only the caller can do that.";
    default:
      return msg || "Error";
  }
}

// The department-appropriate headline shown on the standby card / scene list.
function cueHeadline(c: Cue): string {
  if (c.department === "audio") return `Scene ${c.avantis_scene || "?"}`;
  return c.fire_mode === "fire" ? `Q ${c.cue_number}` : c.fire_mode.toUpperCase();
}

export function ShowMode({ bundle, identity }: Props) {
  const { production, characters, lines, sections, cues } = bundle;

  // --- live-sync context (from the WS hub) ----------------------------------
  const { you, state, generation, eos: wsEos } = useWs();
  const role = you?.role ?? identity.role;
  const isAdmin = you?.is_admin ?? identity.isAdmin;
  const callerUserId = state?.callerUserId ?? null;
  const isCaller = !!you && you.id === callerUserId;
  // The department this client OPERATES (fires). Only lights/audio fire; caller
  // (pure), viewer and spot don't — they get a read/position view with no GO.
  const myDept: FiringDept | null =
    role === "lights" || role === "audio" ? role : null;
  const canFire = myDept !== null;
  const wsPosition = state?.position ?? { key: "", idx: 0 };

  const order = useMemo(() => buildOrder(lines, sections, cues), [lines, sections, cues]);
  const landmarks = useMemo(() => landmarkIndices(order), [order]);
  const sceneStarts = useMemo(() => sceneStartIndices(order), [order]);
  const settings = useMemo(() => parseShowSettings(production), [production]);

  // ==========================================================================
  // Local reading state (per-client) — the reading playhead. GO never moves it
  // (unless the opt-in followGo for a solo caller). For the CALLER the cursor
  // drives the global position (M1 wiring below).
  // ==========================================================================
  const [cursor, setCursor] = useState(0);
  const [log, setLog] = useState<LogItem[]>([]);
  const [sceneMenu, setSceneMenu] = useState(false);
  const [engaged, setEngaged] = useState(true);
  // Optimistic GO disable: true from a GO send until fired/error arrives.
  const [pending, setPending] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // Dept lens: operators default "mine" (their cues only), viewer/caller "all".
  const [lens, setLens] = useState<"all" | "mine">(() => {
    const saved = localStorage.getItem(LENS_KEY);
    if (saved === "all" || saved === "mine") return saved;
    return role === "lights" || role === "audio" ? "mine" : "all";
  });
  // Per-device: hide stage directions in the script column. Lines that carry
  // cues, or that are currently load-bearing (reading line / armed / caller
  // line), stay visible so nothing show-critical can disappear.
  const [hideStageDirs, setHideStageDirs] = useState(
    () => localStorage.getItem(HIDE_SD_KEY) === "1",
  );
  const toggleStageDirs = useCallback(() => {
    setHideStageDirs((v) => {
      const next = !v;
      try {
        localStorage.setItem(HIDE_SD_KEY, next ? "1" : "0");
      } catch {
        /* private mode — setting just won't persist */
      }
      return next;
    });
  }, []);

  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chainRef = useRef(false); // a smart-arrow fire chain is in flight
  // M1 caller/follow bookkeeping.
  const lastSentKeyRef = useRef<string | null>(null);
  const wasCallerRef = useRef(false);
  const followMirrorRef = useRef(false);

  const colorOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of characters) map.set(c.name, c.color);
    return (line: ScriptLine) => line.color_override ?? map.get(line.speaker) ?? "";
  }, [characters]);

  // --- derived armed state (§5.1: DERIVED, never stored) --------------------
  // The armed pointer keys off the GLOBAL position while FOLLOWING the caller.
  // An operator who unhooks (FOLLOWING OFF) — or has no caller at all — works
  // exactly as if there were no caller: armed, guard and GO anchor to their
  // OWN reading line (v1 solo semantics). The anchor travels with go/exitLoop
  // so the server validates against the same basis.
  const posIdx = useMemo(
    () => resolvePosIdx(order, wsPosition.key, wsPosition.idx),
    [order, wsPosition.key, wsPosition.idx],
  );
  const anchored = canFire && !isCaller && (!engaged || callerUserId === null);
  const basisIdx = anchored ? cursor : posIdx;
  const anchorKey = anchored ? order[cursor]?.key : undefined;
  const ds = myDept && state ? state.depts[myDept] : undefined;
  const firedKey = ds ? ds.firedKeys.join("|") : "";
  const myStops = useMemo(
    () => (myDept ? deptStops(order, myDept) : []),
    [order, myDept],
  );
  const armedIdx = useMemo(
    () => (myDept ? computeArmed(order, myDept, basisIdx, ds?.firedKeys ?? []) : -1),
    // firedKey stands in for ds.firedKeys (memo-stable dependency).
    [order, myDept, basisIdx, firedKey],
  );
  const armed = armedIdx >= 0 ? order[armedIdx] : undefined;
  const done = canFire && armedIdx < 0;
  const armedIsLoop = !!armed && isLoopStop(armed);
  const armedCues = armed && myDept ? deptCues(armed, myDept) : [];
  const armedKey = armed?.key ?? "";
  // Loop step only shows when we're actually parked on the loop we last cycled
  // (guards stale loopKey/loopStep leaking from the mirror after exitLoop).
  const loopStep =
    armedIsLoop && ds && ds.loopKey === armedKey ? ds.loopStep : 0;
  const standbyNo = armed
    ? myStops.findIndex((s) => s.key === armed.key) + 1
    : myStops.length;

  const aheadBy = armedIdx - basisIdx;
  const ahead = !done && armedIdx >= 0 && armedIdx > basisIdx;
  const guarded = settings.goGuard > 0 && armedIdx >= 0 && aheadBy > settings.goGuard;

  // Console live/stub banner (operators only), dept-aware.
  const consoleLive =
    myDept === "lights"
      ? !!production.osc_enabled && !!production.osc_ip
      : myDept === "audio"
        ? !!production.avantis_enabled && !!production.avantis_ip
        : false;

  // The Ion's live active cue (Eos TCP monitor). WS frames keep it fresh; the
  // one-shot GET seeds it on mount (and nudges the server to start monitoring).
  const [eosSeed, setEosSeed] = useState<{ connected: boolean; cue: EosActiveCue | null } | null>(
    null,
  );
  useEffect(() => {
    if (myDept !== "lights" || !production.osc_enabled || !production.osc_ip) return;
    api.eosActive(production.id).then(setEosSeed).catch(() => {});
  }, [myDept, production.id, production.osc_enabled, production.osc_ip]);
  const eos = wsEos ?? eosSeed;

  // --- helpers ---------------------------------------------------------------

  const setLensP = useCallback((v: "all" | "mine") => {
    setLens(v);
    try {
      localStorage.setItem(LENS_KEY, v);
    } catch {
      /* private mode — lens just won't persist */
    }
  }, []);

  const clearPendingTimer = useCallback(() => {
    if (pendingTimerRef.current) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
  }, []);

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const appendLog = useCallback((dept: Department, entries: FireLogEntry[]) => {
    if (!entries.length) return;
    const tagged: LogItem[] = entries.map((e) => ({ ...e, dept }));
    setLog((l) => [...tagged.reverse(), ...l].slice(0, 30));
  }, []);

  // Move the CALLER's position (solo followGo / smart arrows). setCursor flows
  // through the caller-broadcast effect below, which sends `position`.
  const moveCallerTo = useCallback(
    (idx: number) => setCursor(Math.max(0, Math.min(order.length - 1, idx))),
    [order.length],
  );

  // --- firing (server-authoritative) ----------------------------------------

  const go = useCallback(
    (force?: boolean) => {
      if (!myDept || done || pending) return;
      if (guarded && !force) {
        showToast(errorText("guarded", ""));
        return;
      }
      const key = order[armedIdx]?.key;
      if (!key) return;
      setPending(true);
      clearPendingTimer();
      // Safety: release the optimistic disable if no fired/error returns (e.g. a
      // dropped frame on flaky wifi) so the button never wedges.
      pendingTimerRef.current = setTimeout(() => setPending(false), 1800);
      ws.send({
        type: "go",
        dept: myDept,
        expectedKey: key,
        force: !!force,
        ...(anchorKey ? { anchorKey } : {}),
      });
    },
    [myDept, done, pending, guarded, order, armedIdx, anchorKey, showToast, clearPendingTimer],
  );

  // The loop key WE just asked to exit — when the confirming `rearmed` lands,
  // a cursor parked exactly ON that loop steps forward one line so the
  // on-position re-arm can't bounce the loop straight back to armed.
  const exitPendingRef = useRef<string | null>(null);

  const exitLoop = useCallback(() => {
    if (!myDept || done) return;
    const key = order[armedIdx]?.key;
    if (!key) return;
    exitPendingRef.current = key;
    ws.send({ type: "exitLoop", dept: myDept, expectedKey: key, ...(anchorKey ? { anchorKey } : {}) });
  }, [myDept, done, order, armedIdx, anchorKey]);

  // "Re-arm from here": clear this dept's fired stops at/after the LOCAL reading
  // cursor so they arm again on the next pass (rehearsal re-run).
  const rearmHere = useCallback(() => {
    if (!myDept) return;
    const key = order[cursor]?.key;
    if (!key) return;
    ws.send({ type: "rearm", dept: myDept, fromKey: key });
    showToast("Re-armed from the reading line.");
  }, [myDept, order, cursor, showToast]);

  const reset = useCallback(() => {
    if (!(isCaller || isAdmin)) return;
    ws.send({ type: "reset" });
  }, [isCaller, isAdmin]);

  // Solo-mode smart forward jump (§5.1/§5.3). Only when this client BOTH holds
  // caller AND operates a firing dept. Sequenced against the server: each fire's
  // expectedKey is the LIVE armed stop (read after the prior fire is applied),
  // so nothing goes stale. Fires with force:true — an arrow-driven fire is
  // intentional and, like v1's autoExec, ignores the manual-GO guard.
  const soloAdvance = useCallback(async () => {
    if (!myDept || !isCaller) return;
    if (chainRef.current) return;
    const live0 = ws.getSnapshot().state;
    if (!live0) {
      setCursor((c) => {
        const n = nextLandmark(landmarks, c);
        return n < 0 ? c : n;
      });
      return;
    }
    chainRef.current = true;
    setPending(true);
    try {
      const pos0 = resolvePosIdx(order, live0.position.key, live0.position.idx);
      const f0 = live0.depts[myDept].firedKeys;
      const a0 = computeArmed(order, myDept, pos0, f0);
      const loopArmed = a0 >= 0 && isLoopStop(order[a0]);
      const anchor = loopArmed ? a0 : pos0;
      const nl = nextLandmark(landmarks, anchor);
      const target = nl < 0 ? Math.min(order.length - 1, loopArmed ? anchor + 1 : anchor) : nl;
      let exitFirePending = false;

      for (let i = 0; i < 64; i++) {
        const live = ws.getSnapshot().state;
        if (!live) break;
        const pos = resolvePosIdx(order, live.position.key, live.position.idx);
        const fired = live.depts[myDept].firedKeys;
        const aIdx = computeArmed(order, myDept, pos, fired);
        if (aIdx < 0 || aIdx > target) break;
        const e = order[aIdx];
        if (isLoopStop(e)) {
          // Exit a loop we pass — navigation, unconditional (v1 →).
          ws.send({ type: "exitLoop", dept: myDept, expectedKey: e.key });
          const r = await waitWsEvent("rearmed", (m) => m.dept === myDept);
          if (!r) break;
          exitFirePending = true;
          continue;
        }
        if (aIdx <= pos) break; // sitting on it → navigate only, don't auto-fire
        const allow = settings.autoExec || (exitFirePending && settings.exitFire);
        if (!allow) break;
        // exitFire's single post-loop cue respects the guard (vs the landing).
        if (!settings.autoExec && exitFirePending && settings.exitFire) {
          if (settings.goGuard > 0 && aIdx - target > settings.goGuard) break;
        }
        exitFirePending = false;
        ws.send({ type: "go", dept: myDept, expectedKey: e.key, force: true });
        const fr = await waitWsEvent("fired", (m) => m.dept === myDept && m.stopKey === e.key);
        if (!fr) break;
      }
      moveCallerTo(target);
    } finally {
      chainRef.current = false;
      setPending(false);
    }
  }, [myDept, isCaller, order, landmarks, settings, moveCallerTo]);

  const blockForward = useCallback(() => {
    if (isCaller && myDept) void soloAdvance();
    else
      setCursor((c) => {
        const n = nextLandmark(landmarks, c);
        return n < 0 ? c : n;
      });
  }, [isCaller, myDept, soloAdvance, landmarks]);

  // --- fired / rearmed / error subscriptions --------------------------------
  useEffect(() => {
    const offFired = ws.on("fired", (p) => {
      const m = p as Extract<S2C, { type: "fired" }>;
      appendLog(m.dept, m.entries);
      if (m.dept === myDept) {
        setPending(false);
        clearPendingTimer();
        const isLoopFire = typeof m.loopStep === "number";
        // followGo (solo): move the caller's position to just after the fired
        // stop. Suppressed during a smart-arrow chain (it moves position itself).
        if (isCaller && settings.followGo && !isLoopFire && !chainRef.current) {
          const fi = order.findIndex((e) => e.key === m.stopKey);
          if (fi >= 0) moveCallerTo(fi + 1);
        }
        // UNHOOKED operator (armed anchors to the local cursor): our own GO
        // moves the reading cursor to just after the fired stop, so the next
        // cue arms — as if there were no caller. Loop GOs stay parked (the
        // loop keeps cycling); other operators' fires never move our cursor.
        else if (anchored && !isLoopFire && m.byUserId === (you?.id ?? -1)) {
          const fi = order.findIndex((e) => e.key === m.stopKey);
          if (fi >= 0) setCursor(Math.min(order.length - 1, fi + 1));
        }
      }
    });
    const offRearmed = ws.on("rearmed", (p) => {
      const m = p as Extract<S2C, { type: "rearmed" }>;
      if (m.dept === myDept) {
        setPending(false);
        clearPendingTimer();
        // Our own exitLoop confirmed: if the reading cursor is parked exactly
        // ON the exited loop, step it one line forward — otherwise the
        // on-position re-arm exception arms the loop right back (§5.1) and
        // Enter/Exit appears to do nothing. Only when we own our cursor
        // (solo caller+dept, or unhooked operator); engaged followers stay put.
        const exited = exitPendingRef.current;
        exitPendingRef.current = null;
        if (exited && m.firedKeys.includes(exited) && (isCaller || anchored)) {
          const li = order.findIndex((e) => e.key === exited);
          if (li >= 0) {
            setCursor((c) => (c === li ? Math.min(order.length - 1, li + 1) : c));
          }
        }
      }
    });
    const offErr = ws.on("error", (p) => {
      const m = p as Extract<S2C, { type: "error" }>;
      exitPendingRef.current = null;
      setPending(false);
      clearPendingTimer();
      showToast(errorText(m.code, m.msg));
    });
    return () => {
      offFired();
      offRearmed();
      offErr();
    };
  }, [myDept, isCaller, anchored, you?.id, settings.followGo, order, appendLog, moveCallerTo, showToast, clearPendingTimer]);

  // A full snapshot (reconnect/resume/reset) invalidates any in-flight GO.
  useEffect(() => {
    setPending(false);
    chainRef.current = false;
    exitPendingRef.current = null;
    clearPendingTimer();
  }, [generation, clearPendingTimer]);

  useEffect(
    () => () => {
      clearPendingTimer();
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    },
    [clearPendingTimer],
  );

  // ==========================================================================
  // M1 live-sync: caller-owned global position + engage/disengage follow.
  // ==========================================================================
  const posThrottle = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    pending: { key: string; idx: number; adminOverride: boolean } | null;
    last: number;
  }>({ timer: null, pending: null, last: 0 });

  const sendPositionThrottled = useCallback((key: string, idx: number, adminOverride = false) => {
    const st = posThrottle.current;
    st.pending = { key, idx, adminOverride };
    const flush = () => {
      st.timer = null;
      st.last = Date.now();
      if (st.pending) {
        ws.send({
          type: "position",
          key: st.pending.key,
          idx: st.pending.idx,
          ...(st.pending.adminOverride ? { adminOverride: true } : {}),
        });
        st.pending = null;
      }
    };
    const elapsed = Date.now() - st.last;
    if (elapsed >= 40) flush();
    else if (!st.timer) st.timer = setTimeout(flush, 40 - elapsed);
  }, []);

  useEffect(
    () => () => {
      if (posThrottle.current.timer) clearTimeout(posThrottle.current.timer);
    },
    [],
  );

  // ADMIN override (premiere insurance): while an admin HOLDS P, their cursor
  // moves drive the global position — a temporary caller hijack. Releasing P
  // (or leaving the window) ends it; the caller flag never moves, so the real
  // caller resumes control with their next move.
  const [pOverride, setPOverride] = useState(false);
  useEffect(() => {
    if (!isAdmin || isCaller) {
      setPOverride(false);
      return;
    }
    const isTyping = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
    };
    const down = (e: KeyboardEvent) => {
      if (e.code === "KeyP" && !e.repeat && !isTyping(e)) setPOverride(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "KeyP") setPOverride(false);
    };
    const off = () => setPOverride(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", off);
      setPOverride(false);
    };
  }, [isAdmin, isCaller]);

  // While the override is held, every cursor move (and the moment of pressing)
  // broadcasts the admin's position with the override flag.
  useEffect(() => {
    if (!pOverride || !isAdmin || isCaller) return;
    const key = order[cursor]?.key;
    if (!key) return;
    sendPositionThrottled(key, cursor, true);
  }, [pOverride, cursor, isAdmin, isCaller, order, sendPositionThrottled]);

  // CALLER — broadcast our cursor whenever it lands on a new stop. On BECOMING
  // caller, adopt the server's live position instead of clobbering it.
  useEffect(() => {
    if (!isCaller) {
      wasCallerRef.current = false;
      return;
    }
    if (!wasCallerRef.current) {
      wasCallerRef.current = true;
      const idx = resolvePosIdx(order, wsPosition.key, wsPosition.idx);
      if (idx >= 0) {
        lastSentKeyRef.current = order[idx]?.key ?? null;
        setCursor(idx);
      } else {
        lastSentKeyRef.current = order[cursor]?.key ?? null;
      }
      return;
    }
    const key = order[cursor]?.key;
    if (!key || key === lastSentKeyRef.current) return;
    lastSentKeyRef.current = key;
    sendPositionThrottled(key, cursor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, isCaller, order, sendPositionThrottled]);

  // CALLER — adopt position moves made by SOMEONE ELSE (an admin P-hold
  // override): snap our cursor there so our next move continues from the new
  // spot instead of yanking the show back to the stale one. Our own broadcast
  // echoes are ignored via byUserId.
  useEffect(() => {
    if (!isCaller) return;
    const off = ws.on("position", (p) => {
      const m = p as { key: string; idx: number; byUserId?: number };
      if (m.byUserId === undefined || m.byUserId === (you?.id ?? -1)) return;
      const idx = resolvePosIdx(order, m.key, m.idx);
      if (idx < 0) return;
      lastSentKeyRef.current = m.key;
      setCursor(idx);
    });
    return off;
  }, [isCaller, you?.id, order]);

  // CALLER — on every full snapshot (reconnect / resume / reset), adopt the
  // server's position so a reconnecting caller lands where the show is.
  useEffect(() => {
    if (!isCaller) return;
    const key = wsPosition.key;
    if (!key) return;
    const idx = resolvePosIdx(order, key, wsPosition.idx);
    if (idx < 0) return;
    lastSentKeyRef.current = key;
    setCursor(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation]);

  // FOLLOWER (non-caller) + ENGAGED — mirror the caller's position onto cursor.
  useEffect(() => {
    if (isCaller || !engaged) return;
    const idx = resolvePosIdx(order, wsPosition.key, wsPosition.idx);
    if (idx < 0 || idx === cursor) return;
    followMirrorRef.current = true;
    setCursor(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsPosition.key, wsPosition.idx, engaged, isCaller, order]);

  // FOLLOWER — disengage when the cursor moves off the caller line by any manual
  // means. A move made BY the mirror is flagged and skipped.
  useEffect(() => {
    if (isCaller || !engaged) return;
    if (followMirrorRef.current) {
      followMirrorRef.current = false;
      return;
    }
    const idx = resolvePosIdx(order, wsPosition.key, wsPosition.idx);
    if (idx >= 0 && cursor !== idx) setEngaged(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor]);

  const snapBack = useCallback(() => {
    setEngaged(true);
    const idx = resolvePosIdx(order, wsPosition.key, wsPosition.idx);
    if (idx >= 0) setCursor(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsPosition.key, wsPosition.idx, order]);

  // The caller line as a local index — a subtle marker for followers.
  const callerIdx =
    !isCaller && callerUserId != null
      ? resolvePosIdx(order, wsPosition.key, wsPosition.idx)
      : -1;

  // --- scene header ----------------------------------------------------------
  const currentSceneIdx = useMemo(() => {
    const at = currentSceneStart(sceneStarts, cursor);
    return at >= 0 ? at : sceneStarts.length ? sceneStarts[0] : -1;
  }, [sceneStarts, cursor]);
  const currentScene = currentSceneIdx >= 0 ? order[currentSceneIdx] : undefined;

  const jumpToScene = useCallback((idx: number) => {
    setCursor(idx);
    setSceneMenu(false);
  }, []);

  // --- keyboard --------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.code === "Escape") {
        setSceneMenu(false);
        return;
      }
      if (t && typeof t.closest === "function" && t.closest(".scene-head")) return;
      if (e.code === "KeyF") {
        if (!isCaller) {
          e.preventDefault();
          snapBack();
        }
        return;
      }
      if (e.code === "Space" || e.code === "Enter") {
        e.preventDefault();
        if (e.repeat) return; // holding Space fires exactly one cue
        if (!canFire) return;
        // Enter on an armed LOOP exits it (Space keeps cycling); otherwise GO.
        if (e.code === "Enter" && armedIsLoop) exitLoop();
        else go(e.shiftKey);
      } else if (e.code === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(order.length - 1, c + 1));
      } else if (e.code === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        if (isCaller && myDept) void soloAdvance();
        else
          setCursor((c) => {
            const n = nextLandmark(landmarks, c);
            return n < 0 ? c : n;
          });
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        setCursor((c) => {
          const prev = prevLandmark(landmarks, c);
          return prev < 0 ? c : prev;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, exitLoop, armedIsLoop, soloAdvance, order.length, landmarks, canFire, isCaller, myDept, snapBack]);

  // Keep the current line in view.
  const scriptRef = useRef<HTMLDivElement>(null);
  const currentKey = order[cursor]?.key;
  useEffect(() => {
    if (!currentKey) return;
    scriptRef.current
      ?.querySelector<HTMLElement>(`[data-key="${currentKey}"]`)
      ?.scrollIntoView({ block: "center", behavior: "auto" });
  }, [currentKey]);

  // FOLLOWER — a manual wheel/touch scroll is a "read ahead": disengage.
  useEffect(() => {
    if (isCaller) return;
    const el = scriptRef.current;
    if (!el) return;
    const off = () => setEngaged(false);
    el.addEventListener("wheel", off, { passive: true });
    el.addEventListener("touchmove", off, { passive: true });
    return () => {
      el.removeEventListener("wheel", off);
      el.removeEventListener("touchmove", off);
    };
  }, [isCaller]);

  // scrollArmed (opt-in): briefly reveal the armed cue, then return to reading.
  const currentKeyRef = useRef(currentKey);
  useEffect(() => {
    currentKeyRef.current = currentKey;
  }, [currentKey]);
  useEffect(() => {
    if (!settings.scrollArmed || !armedKey || !canFire) return;
    const root = scriptRef.current;
    if (!root) return;
    root
      .querySelector<HTMLElement>(`[data-key="${armedKey}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
    const t = setTimeout(() => {
      const key = currentKeyRef.current;
      if (!key) return;
      root
        .querySelector<HTMLElement>(`[data-key="${key}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armedKey, settings.scrollArmed, canFire]);

  // Close the scene menu on any click outside the header/menu.
  const sceneHeadRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!sceneMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!sceneHeadRef.current?.contains(e.target as Node)) setSceneMenu(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [sceneMenu]);

  const sceneLabel = (entry: OrderEntry) => entry.line.text?.trim() || `(${entry.line.type})`;

  const showNav = canFire || isCaller;

  return (
    <div className="show">
      {pOverride ? (
        <div className="follow-pill override-pill">
          CALLER OVERRIDE — your moves drive the show position (release <kbd>P</kbd> to stop)
        </div>
      ) : (
        !isCaller &&
        !engaged && (
          <button className="follow-pill" onClick={snapBack} title="Re-engage following">
            FOLLOWING OFF — {canFire ? "cues arm from your line · " : ""}press <kbd>F</kbd> to
            snap back
          </button>
        )
      )}
      {toast && <div className="show-toast">{toast}</div>}
      <div className="show-script" ref={scriptRef}>
        <div className="scene-head" ref={sceneHeadRef}>
          <button
            className={"scene-head-bar" + (sceneMenu ? " open" : "")}
            onClick={() => setSceneMenu((v) => !v)}
            title="Jump to act / scene / pause"
            disabled={sceneStarts.length === 0}
          >
            <span className="scene-head-eyebrow">Scene</span>
            <span
              className={
                "scene-head-title" + (currentScene ? " type-" + currentScene.line.type : "")
              }
            >
              {currentScene ? sceneLabel(currentScene) : production.name}
            </span>
            {sceneStarts.length > 0 && <span className="scene-head-caret">▾</span>}
          </button>
          <button
            className={"sd-toggle" + (hideStageDirs ? " on" : "")}
            onClick={toggleStageDirs}
            title={
              hideStageDirs
                ? "Stage directions hidden (except cue-bearing ones) — click to show"
                : "Click to hide stage directions in the script"
            }
          >
            {hideStageDirs ? "( ) hidden" : "(stage dirs)"}
          </button>
          {sceneMenu && (
            <div className="scene-menu" role="menu">
              {sceneStarts.map((idx) => {
                const e = order[idx];
                return (
                  <button
                    key={e.key}
                    role="menuitem"
                    className={
                      "scene-menu-item type-" +
                      e.line.type +
                      (idx === currentSceneIdx ? " active" : "")
                    }
                    onClick={() => jumpToScene(idx)}
                  >
                    <span className="scene-menu-kind">{e.line.type}</span>
                    <span className="scene-menu-text">{sceneLabel(e)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {canFire &&
          (consoleLive ? (
            <div className="banner live">
              ● LIVE —{" "}
              {myDept === "lights"
                ? `sending OSC to ${production.osc_ip}:${production.osc_port} (${production.osc_protocol})`
                : `sending MIDI to ${production.avantis_ip}:${production.avantis_port}`}
            </div>
          ) : (
            <div className="banner warn">
              Rehearsal / stub mode — GO builds &amp; logs the message but does not transmit. Enable
              live send in Settings.
            </div>
          ))}
        {order.length === 0 && <p className="empty">No script yet. Add lines in the Script tab.</p>}
        {order.map((entry, i) => {
          const color = colorOf(entry.line);
          const isSection = entry.kind === "section";
          const isCurrent = i === cursor;
          const isStandby = canFire && i === armedIdx;
          // Per-device stage-dir hiding: skip plain stage directions, but never
          // hide one that carries cues or is load-bearing right now.
          if (
            hideStageDirs &&
            entry.line.type === "stage_dir" &&
            entry.cues.length === 0 &&
            !isCurrent &&
            !isStandby &&
            i !== callerIdx
          ) {
            return null;
          }
          const label = isSection
            ? `${entry.line.text || "Song"} — ${entry.section?.label || "section"}`
            : entry.line.speaker
              ? `${entry.line.speaker}: ${entry.line.text}`
              : entry.line.text || `(${entry.line.type})`;
          // Department-scoped notes: the legacy `note` column is the LIGHTS
          // note, `note_audio` is the audio operator's. Each operator sees only
          // their own department's notes; caller/viewer see both (tagged).
          const lightsNote = (isSection ? entry.section?.note : entry.line.note)?.trim();
          const audioNote = (isSection ? entry.section?.note_audio : entry.line.note_audio)?.trim();
          const notes: { dept: Department; text: string }[] = [];
          if (role !== "audio" && lightsNote) notes.push({ dept: "lights", text: lightsNote });
          if (role !== "lights" && audioNote) notes.push({ dept: "audio", text: audioNote });
          const tagNotes = role !== "lights" && role !== "audio"; // seeing several depts → tag them
          const lyrics = isSection ? entry.section?.lyrics?.trim() : "";
          return (
            <div
              key={entry.key}
              data-key={entry.key}
              className={
                "show-line type-" +
                entry.line.type +
                (isCurrent ? " current" : "") +
                (isStandby ? " standby-next" : "") +
                (i < cursor ? " past" : "") +
                (isSection ? " show-section" : "") +
                (i === callerIdx ? " caller-line" : "")
              }
              style={{
                borderLeftColor: color || undefined,
                background: isCurrent ? undefined : color ? tint(color, 0.08) : undefined,
              }}
              onClick={() => setCursor(i)}
            >
              <span className="show-line-main">
                {isSection ? (
                  <span className="muted">{entry.line.type === "pause" ? "⏸ " : "🎵 "}</span>
                ) : null}
                {entry.section?.loop === 1 ? (
                  <span className="loop-marker" title="Loop section">
                    🔁{" "}
                  </span>
                ) : null}
                {label}
                {entry.cues.map((c) => {
                  if (lens === "mine" && canFire && c.department !== myDept) return null;
                  const dimmed = lens === "all" && canFire && c.department !== myDept;
                  return (
                    <span
                      key={c.id}
                      className={"pill dept-" + c.department}
                      style={{ marginLeft: 6, opacity: dimmed ? 0.35 : undefined }}
                    >
                      {buildCuePreview(c, production)}
                    </span>
                  );
                })}
                {lyrics ? <div className="show-lyrics">{lyrics}</div> : null}
              </span>
              {notes.length > 0 ? (
                <span className="show-note">
                  {notes.map((n) => (
                    <span key={n.dept} className={"show-note-item note-" + n.dept}>
                      {tagNotes ? (
                        <span className={"note-dept-tag dept-" + n.dept}>{DEPT_TAG[n.dept]}</span>
                      ) : null}
                      {n.text}
                    </span>
                  ))}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="show-side">
        {canFire && (
          <div className={"standby" + (armedIsLoop ? " loop" : "")}>
            <div className="standby-label">
              <span className={"dept-chip dept-" + myDept}>{myDept}</span>
              <span className="spacer" />
              <button
                className={"lens-toggle" + (lens === "mine" ? " on" : "")}
                onClick={() => setLensP(lens === "mine" ? "all" : "mine")}
                title="Toggle showing other departments' cues"
              >
                {lens === "mine" ? "Mine only" : "All depts"}
              </button>
            </div>
            <div className="standby-sub">
              {done
                ? "End of show"
                : armedIsLoop
                  ? `🔁 LOOP · ${armed!.section?.label || "section"} — cue ${standbyNo} of ${myStops.length}`
                  : `Standby — cue ${standbyNo} of ${myStops.length}`}
            </div>
            {myDept === "lights" && consoleLive && eos && (
              <div
                className={"eos-now" + (eos.connected ? "" : " down")}
                title="Live from the console (Eos OSC TCP, port 3032)"
              >
                {eos.connected ? (
                  eos.cue ? (
                    <>
                      Ion at <b>Q {eos.cue.list}/{eos.cue.number}</b>
                      {eos.cue.text ? (
                        <span className="eos-text">
                          {" · "}
                          {eos.cue.text.replace(/^\d+\/[\d.]+\s*/, "")}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    "Ion connected — no active cue yet"
                  )
                ) : (
                  "Ion cue link down"
                )}
              </div>
            )}
            {armed ? (
              armedIsLoop && armedCues.length > 0 ? (
                <div className="loop-standby">
                  <div className="loop-next">
                    Next:&nbsp;
                    <b>{cueHeadline(armedCues[loopStep % armedCues.length])}</b>
                    <span className="loop-pos">
                      &nbsp;({(loopStep % armedCues.length) + 1}/{armedCues.length})
                    </span>
                    <span className="loop-fired">&nbsp;· {loopStep} fired</span>
                  </div>
                  {armedCues.map((c, ci) => {
                    const isNext = ci === loopStep % armedCues.length;
                    return (
                      <div key={c.id} className={"loop-cue" + (isNext ? " next" : "")}>
                        <div className="standby-cue" style={isNext ? undefined : { fontSize: 20 }}>
                          {isNext ? "▶ " : ""}
                          {cueHeadline(c)}
                          {c.label ? (
                            <span style={{ fontSize: 15, fontWeight: 400 }}> · {c.label}</span>
                          ) : null}
                        </div>
                        <div className="standby-msg">{buildCuePreview(c, production)}</div>
                        {c.notes ? <div className="standby-note">{c.notes}</div> : null}
                      </div>
                    );
                  })}
                  <p className="hint" style={{ marginTop: 8 }}>
                    Space/GO fires the next cue and stays here. Enter or Exit to move on.
                  </p>
                </div>
              ) : (
                armedCues.map((c) => (
                  <div key={c.id}>
                    <div className="standby-cue">
                      {cueHeadline(c)}
                      {c.label ? (
                        <span style={{ fontSize: 16, fontWeight: 400 }}> · {c.label}</span>
                      ) : null}
                    </div>
                    <div className="standby-msg">{buildCuePreview(c, production)}</div>
                    {c.notes ? <div className="standby-note">{c.notes}</div> : null}
                  </div>
                ))
              )
            ) : (
              <div className="muted" style={{ marginTop: 8 }}>
                All cues fired. Re-arm to run again.
              </div>
            )}
            {!done && ahead ? (
              guarded ? (
                <div className="ahead-hint blocked">
                  blocked — cue ahead by {aheadBy} (guard {settings.goGuard}) · Shift+GO to override
                </div>
              ) : (
                <div className="ahead-hint">next cue ahead by {aheadBy}</div>
              )
            ) : null}
            <button
              className={
                "go-btn" +
                (armedIsLoop ? " loop" : "") +
                (ahead ? " ahead" : "") +
                (guarded ? " blocked" : "")
              }
              onClick={(e) => go(e.shiftKey)}
              disabled={done || pending}
              title={
                guarded ? "Cue is far ahead — Shift+click to override the guard" : undefined
              }
            >
              {armedIsLoop ? "GO (loop)" : "GO"}
            </button>
            {armedIsLoop && (
              <button
                className="btn-sm exit-loop"
                onClick={exitLoop}
                style={{ width: "100%", marginTop: 8 }}
              >
                Exit loop ▸
              </button>
            )}
          </div>
        )}

        {myDept === "audio" && myStops.length > 0 && (
          <div className="scene-list">
            <div className="scene-list-head">
              <b>Audio scenes</b>
              <span className="hint">
                &nbsp;({ds?.firedKeys.length ?? 0}/{myStops.length} fired)
              </span>
            </div>
            <div className="scene-list-body">
              {myStops.map((e) => {
                const c = deptCues(e, "audio")[0];
                const fired = ds?.firedKeys.includes(e.key) ?? false;
                const isArmed = armed?.key === e.key;
                const status = isArmed ? "armed" : fired ? "fired" : "up";
                return (
                  <div key={e.key} className={"scene-item " + status}>
                    <span className="scene-item-mark">
                      {isArmed ? "▶" : fired ? "✓" : "·"}
                    </span>
                    <span className="scene-item-name">{c ? cueHeadline(c) : "—"}</span>
                    {c?.label ? <span className="scene-item-label">{c.label}</span> : null}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {showNav && (
          <div className="show-nav">
            <div className="row">
              <button className="btn-sm" onClick={() => setCursor((c) => Math.max(0, c - 1))}>
                ‹ Prev line
              </button>
              <button
                className="btn-sm"
                onClick={() => setCursor((c) => Math.min(order.length - 1, c + 1))}
              >
                Next line ›
              </button>
              <span className="spacer" />
              {(isCaller || isAdmin) && (
                <button className="btn-ghost btn-sm" onClick={reset}>
                  Reset
                </button>
              )}
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <button
                className="btn-sm"
                title="Jump to previous speaker / scene / song"
                onClick={() =>
                  setCursor((c) => {
                    const prev = prevLandmark(landmarks, c);
                    return prev < 0 ? c : prev;
                  })
                }
              >
                ‹‹ Prev block
              </button>
              <button
                className="btn-sm"
                title="Jump to next speaker / scene / song"
                onClick={blockForward}
              >
                Next block ››
              </button>
              <span className="spacer" />
              {canFire && (
                <button className="btn-ghost btn-sm" onClick={rearmHere} title="Clear fired cues from the reading line down">
                  Re-arm from here
                </button>
              )}
            </div>
            <p className="hint" style={{ marginTop: 8 }}>
              {canFire
                ? "Space/Enter = GO · Enter exits loops · ↑↓ = line · ←→ = block · F to re-engage"
                : isCaller
                  ? "Click a line or ↑↓ / ←→ to move the show position for everyone"
                  : "↑↓ / ←→ to read · F to re-engage the caller"}
            </p>
          </div>
        )}

        <div className="osc-log">
          <div className="row" style={{ marginBottom: 6 }}>
            <b>Fire log</b>
            <span className="hint">(last 30, all depts)</span>
            <span className="spacer" />
            <button className="btn-ghost btn-sm" onClick={() => setLog([])}>
              clear
            </button>
          </div>
          {log.length === 0 && <div className="muted">Fired cues appear here.</div>}
          {log.map((e, i) => (
            <div key={i} className={"log-entry " + (e.sent ? "sent" : "stub")}>
              <span className={"log-dept dept-" + e.dept}>{DEPT_TAG[e.dept]}</span>
              <span className="tag">{e.sent ? "SENT" : "STUB"}</span>
              <span>{e.preview}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
