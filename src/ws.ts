// src/ws.ts — client WebSocket wrapper (§4.4).
//
// One long-lived connection to the live-sync hub. Responsibilities:
//   - connect to (wss|ws)://<host>/ws?token=… (same origin in prod, Vite proxy in dev)
//   - keep a mirror of the room: `you`, `state` (RoomState), `roster`, `status`
//   - app-level heartbeat every 10s (browser JS can't see WS ping/pong)
//   - watchdog: 12s of total silence => offline + force-close + reconnect
//   - capped backoff reconnect (0.5/1/2/4/5s); instant retry on online/visible
//   - seq-gap detection on the seq-carrying frames => request a full `sync`
//
// Exposed as a singleton `ws`. React consumers use `useWs()` (a
// useSyncExternalStore binding) to read the live snapshot reactively.

import { useSyncExternalStore } from "react";
import type { C2S, EosActiveCue, RoomState, RosterEntry, S2C, UserPublic } from "../shared/protocol";

export type WsStatus = "connecting" | "online" | "offline";

export interface WsSnapshot {
  status: WsStatus;
  you: UserPublic | null;
  state: RoomState | null;
  roster: RosterEntry[];
  // Bumps on every full snapshot (welcome/state). ShowMode keys its
  // "adopt server position" effect on this so a reconnect resumes cleanly.
  generation: number;
  // Console mirror (Eos TCP monitor): the Ion's live active cue. null until
  // the first eosCue frame arrives (ShowMode seeds it via GET /eos/active).
  eos: { connected: boolean; cue: EosActiveCue | null } | null;
}

type WsEvent =
  | "kicked"
  | "unauthorized"
  | "dataChanged"
  | "error"
  | "position"
  | "fired"
  | "rearmed"
  | "spotFlash";

const HB_CLIENT_MS = 10_000; // app heartbeat cadence
const WATCHDOG_MS = 12_000; // silence => offline + reconnect
const WATCH_TICK_MS = 2_000; // how often the watchdog checks
const BACKOFF = [500, 1000, 2000, 4000, 5000];

const EMPTY: WsSnapshot = {
  status: "offline",
  you: null,
  state: null,
  roster: [],
  generation: 0,
  eos: null,
};

class WsClient {
  private token: string | null = null;
  private socket: WebSocket | null = null;
  private sockGen = 0; // bumped per connect; stale socket events are ignored
  private backoffIdx = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private globalInstalled = false;
  private lastActivity = 0;
  private lastSeq = 0;

  private snap: WsSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private events = new Map<WsEvent, Set<(payload: unknown) => void>>();

  // --- external store (React) ----------------------------------------------

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = (): WsSnapshot => this.snap;

  private setSnap(patch: Partial<WsSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const l of this.listeners) l();
  }

  // --- event emitter (imperative side-effects: kick, refetch, errors) ------

  on(evt: WsEvent, cb: (payload: unknown) => void): () => void {
    let set = this.events.get(evt);
    if (!set) {
      set = new Set();
      this.events.set(evt, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }

  private emit(evt: WsEvent, payload?: unknown): void {
    const set = this.events.get(evt);
    if (set) for (const cb of [...set]) cb(payload);
  }

  // --- lifecycle ------------------------------------------------------------

  connect(token: string): void {
    // Already connected/connecting to this exact token — nothing to do.
    if (
      this.token === token &&
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.token = token;
    this.lastSeq = 0;
    this.backoffIdx = 0;
    this.startTimers();
    this.installGlobalListeners();
    this.open();
  }

  disconnect(): void {
    this.token = null;
    this.sockGen++; // invalidate any in-flight socket's callbacks
    this.clearReconnect();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* already closing */
      }
      this.socket = null;
    }
    if (this.hbTimer) {
      clearInterval(this.hbTimer);
      this.hbTimer = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.lastSeq = 0;
    this.snap = { ...EMPTY, generation: this.snap.generation + 1 };
    for (const l of this.listeners) l();
  }

  send = (msg: C2S): void => {
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify(msg));
      } catch {
        /* dropped; reconnect + welcome will re-sync */
      }
    }
  };

  private open(): void {
    if (!this.token) return;
    this.clearReconnect();
    // Drop any prior socket (e.g. a CONNECTING one from a visibility/online
    // retry). Bumping sockGen below makes its callbacks no-ops.
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* already closing */
      }
      this.socket = null;
    }
    const gen = ++this.sockGen;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws?token=${encodeURIComponent(this.token)}`;
    this.setSnap({ status: "connecting" });
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.lastActivity = Date.now();
    socket.onopen = () => {
      if (gen !== this.sockGen) return;
      this.lastActivity = Date.now();
      this.setSnap({ status: "online" });
    };
    socket.onmessage = (e) => {
      if (gen !== this.sockGen) return;
      this.lastActivity = Date.now();
      this.handle(e.data);
    };
    socket.onclose = (e) => {
      if (gen !== this.sockGen) return;
      this.socket = null;
      this.onClose(e.code);
    };
    socket.onerror = () => {
      /* an onclose always follows; handle reconnect there */
    };
  }

  private onClose(code: number): void {
    // 4001 = bad/revoked/kicked/"signed in elsewhere". The identity is dead;
    // do NOT reconnect — let App wipe the token and return to Join.
    if (code === 4001) {
      this.setSnap({ status: "offline" });
      this.emit("unauthorized");
      return;
    }
    // 4002 (silence reap) or any transport drop => reconnect, keep identity.
    this.setSnap({ status: "offline" });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.token || this.reconnectTimer) return;
    const delay = BACKOFF[Math.min(this.backoffIdx, BACKOFF.length - 1)];
    this.backoffIdx++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startTimers(): void {
    if (!this.hbTimer) this.hbTimer = setInterval(() => this.sendHb(), HB_CLIENT_MS);
    if (!this.watchdogTimer)
      this.watchdogTimer = setInterval(() => this.checkWatchdog(), WATCH_TICK_MS);
  }

  private sendHb(): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify({ type: "hb" } satisfies C2S));
      } catch {
        /* ignore */
      }
    }
  }

  private checkWatchdog(): void {
    if (!this.token) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastActivity > WATCHDOG_MS) {
      // Total silence on an "open" socket => the link is dead (booth wifi).
      // Force-close and reconnect fast (reset the backoff so it's ~0.5s).
      this.backoffIdx = 0;
      this.setSnap({ status: "offline" });
      try {
        this.socket.close();
      } catch {
        /* already gone */
      }
      // onclose (gen matches) will schedule the reconnect.
    }
  }

  private installGlobalListeners(): void {
    if (this.globalInstalled || typeof window === "undefined") return;
    this.globalInstalled = true;
    const retry = () => {
      if (!this.token) return;
      if (this.socket && this.socket.readyState === WebSocket.OPEN) return;
      this.backoffIdx = 0;
      this.clearReconnect();
      this.open();
    };
    window.addEventListener("online", retry);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") retry();
    });
  }

  // --- inbound frames -------------------------------------------------------

  private handle(raw: unknown): void {
    let msg: S2C;
    try {
      msg = JSON.parse(String(raw)) as S2C;
    } catch {
      return;
    }
    switch (msg.type) {
      case "hb":
        return; // liveness only (lastActivity already bumped)

      case "welcome":
        this.lastSeq = msg.state.seq;
        this.backoffIdx = 0; // fully synced — clear reconnect backoff
        this.setSnap({
          status: "online",
          you: msg.you,
          state: msg.state,
          roster: msg.roster,
          generation: this.snap.generation + 1,
        });
        return;

      case "state":
        this.lastSeq = msg.state.seq;
        this.setSnap({ state: msg.state, generation: this.snap.generation + 1 });
        return;

      case "position": {
        const gap = msg.seq > this.lastSeq + 1;
        if (msg.seq <= this.lastSeq) return; // stale / reordered — ignore
        this.lastSeq = msg.seq;
        if (this.snap.state) {
          this.setSnap({
            state: { ...this.snap.state, position: { key: msg.key, idx: msg.idx }, seq: msg.seq },
          });
        }
        this.emit("position", { key: msg.key, idx: msg.idx, byUserId: msg.byUserId });
        // A rewind that re-armed fired stops carries `clearedFired` (dept names,
        // not keys). We can't reconstruct which keys dropped without the order,
        // so request a full snapshot to correct the local fired-set. Rewinds are
        // rare; the extra `state` costs one round-trip and re-derives armed.
        if (gap || (msg.clearedFired && msg.clearedFired.length)) this.send({ type: "sync" });
        return;
      }

      // M2 seq-carrying fire frames: apply to the local RoomState mirror so
      // derived armed/loop state advances WITHOUT a full resync, then surface the
      // event for the show views (fired log, followGo, optimistic GO release).
      case "fired": {
        const gap = msg.seq > this.lastSeq + 1;
        if (msg.seq > this.lastSeq) this.lastSeq = msg.seq;
        if (this.snap.state && (msg.dept === "lights" || msg.dept === "audio")) {
          const st = this.snap.state;
          const ds = st.depts[msg.dept];
          const nd =
            typeof msg.loopStep === "number"
              ? // loop GO: stay armed on the loop, advance the cycle counter.
                { firedKeys: [...ds.firedKeys], loopKey: msg.stopKey, loopStep: msg.loopStep }
              : // normal GO: mark the stop fired (dedup) and clear loop state.
                {
                  firedKeys: ds.firedKeys.includes(msg.stopKey)
                    ? [...ds.firedKeys]
                    : [...ds.firedKeys, msg.stopKey],
                  loopKey: null,
                  loopStep: 0,
                };
          this.setSnap({ state: { ...st, seq: msg.seq, depts: { ...st.depts, [msg.dept]: nd } } });
        }
        this.emit("fired", msg);
        if (gap) this.send({ type: "sync" });
        return;
      }

      // rearmed (exitLoop / re-arm-from-here): a full fired-set replacement for
      // the dept. Loop state is cleared — exitLoop clears it, and a stale loop
      // never leaks into the UI because the views gate loop display on
      // loopKey === armedKey.
      case "rearmed": {
        const gap = msg.seq > this.lastSeq + 1;
        if (msg.seq > this.lastSeq) this.lastSeq = msg.seq;
        if (this.snap.state && (msg.dept === "lights" || msg.dept === "audio")) {
          const st = this.snap.state;
          const nd = { firedKeys: [...msg.firedKeys], loopKey: null, loopStep: 0 };
          this.setSnap({ state: { ...st, seq: msg.seq, depts: { ...st.depts, [msg.dept]: nd } } });
        }
        this.emit("rearmed", msg);
        if (gap) this.send({ type: "sync" });
        return;
      }

      case "spotFlash":
        this.emit("spotFlash", msg);
        return;

      case "eosCue":
        this.setSnap({ eos: { connected: msg.connected, cue: msg.cue } });
        return;

      case "timer":
        if (this.snap.state) {
          this.setSnap({
            state: {
              ...this.snap.state,
              timerStartedAt: msg.startedAt,
              timerPausedAt: msg.pausedAt,
              timerPausedMs: msg.pausedMs,
              timerResumeAt: msg.resumeAt,
              timerStoppedAt: msg.stoppedAt,
              showAt: msg.showAt,
            },
          });
        }
        return;

      case "code":
        if (this.snap.state) {
          this.setSnap({ state: { ...this.snap.state, code: msg.code } });
        }
        return;

      case "readyCheck":
        if (this.snap.state) {
          this.setSnap({
            state: { ...this.snap.state, readyCheckAt: msg.at, readyUserIds: msg.ready },
          });
        }
        return;

      case "roster":
        this.setSnap({ roster: msg.roster });
        return;

      case "callerChanged":
        if (this.snap.state) {
          this.setSnap({ state: { ...this.snap.state, callerUserId: msg.userId } });
        }
        return;

      case "dataChanged":
        this.emit("dataChanged", msg.scope);
        return;

      case "kicked":
        this.emit("kicked");
        return;

      case "error":
        this.emit("error", msg);
        return;
    }
  }
}

export const ws = new WsClient();

// React binding: re-renders when the snapshot identity changes.
export function useWs(): WsSnapshot {
  return useSyncExternalStore(ws.subscribe, ws.getSnapshot, ws.getSnapshot);
}
