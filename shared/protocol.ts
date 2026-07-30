// ScriptWarden v2 — WebSocket protocol + shared live-sync types.
//
// SINGLE SOURCE OF TRUTH imported by BOTH the Bun server (server/ws/*) and the
// Vite client (src/ws.ts). Keep it dependency-free (pure types + a couple of
// tiny helpers) so it bundles cleanly on both sides.
//
// The protocol is written in full here (M1..M4) so the shape is stable; M1 only
// *handles* a subset on the server (hb, position, showStart, showStop, reset,
// grantCaller, sync). Department firing (go/exitLoop/rearm) arrives in M2.

export type Department = "lights" | "audio" | "spot";
// "regie" (direction booth): follow-only script view + ready-check participation.
export type Role = "caller" | "lights" | "audio" | "spot" | "viewer" | "regie";

// ---------------------------------------------------------------------------
// Public user + roster shapes (what non-privileged clients are allowed to see).
// ---------------------------------------------------------------------------

export interface UserPublic {
  id: number;
  name: string;
  role: Role;
  spot_no: number;
  is_admin: boolean;
}

export interface RosterEntry {
  user: UserPublic;
  online: boolean;
  isCaller: boolean;
}

// ---------------------------------------------------------------------------
// Fire-log entries carried by the `fired` broadcast (M2+). Union of the two
// console back-ends: Eos (OSC) and Avantis (MIDI-over-TCP, §7). Defined here so
// the protocol type is complete and self-contained.
// ---------------------------------------------------------------------------

export interface OscLogEntry {
  ts: string;
  address: string;
  args: (string | number)[];
  preview: string;
  sent: boolean;
  target?: string;
}

export interface AvantisLogEntry {
  ts: string;
  hex: string;
  preview: string;
  sent: boolean;
  target?: string;
}

export type FireLogEntry = OscLogEntry | AvantisLogEntry;

// The console's live active cue, mirrored from the Eos OSC TCP stream
// (/eos/out/active/cue/...). `text` is Eos's own display string, e.g.
// "1/12 Blackout 3.0 100%". null = no active cue / console not connected.
export interface EosActiveCue {
  list: number;
  number: string;
  text: string;
}

// ---------------------------------------------------------------------------
// Code alerts — "there is an ongoing situation" broadcast. Any crew member can
// raise one, addressed to the whole team (targetUserId null) or to one person.
// yellow = attention / problem, show carries on; red = emergency. One code at a
// time: raising a new one replaces the current (escalation yellow → red works).
// Cleared by the raiser, the caller or an admin.
// ---------------------------------------------------------------------------

export type CodeLevel = "yellow" | "red";

export interface CodeAlert {
  level: CodeLevel;
  msg: string; // optional free text ("what's going on"), may be ""
  targetUserId: number | null; // null = the entire team
  byUserId: number;
  byName: string; // denormalized so the banner renders even off-roster
  at: string; // ISO timestamp raised
}

// ---------------------------------------------------------------------------
// Room state (server-authoritative; §4.3). Persisted to show_state as JSON so a
// server restart resumes the show.
// ---------------------------------------------------------------------------

export interface DeptState {
  firedKeys: string[];
  loopKey: string | null;
  loopStep: number;
}

export interface RoomState {
  seq: number;
  callerUserId: number | null;
  position: { key: string; idx: number }; // key primary (stable across edits); idx advisory
  timerStartedAt: string | null;
  // Show-timer pause: while paused the elapsed display freezes. timerPausedMs
  // accumulates completed pauses; timerResumeAt is an OPTIONAL, informational
  // countdown target ("show resumes at …") — resuming is always a manual act.
  timerPausedAt: string | null;
  timerPausedMs: number;
  timerResumeAt: string | null;
  // Stop does NOT wipe the clock: timerStoppedAt freezes the elapsed display at
  // the final runtime (the number you note down after curtain). Cleared by an
  // explicit timerClear or by starting the next show.
  timerStoppedAt: string | null;
  // Pre-show countdown: informational target for when the show starts. Shown
  // to everyone while the timer isn't running; cleared by showStart/showStop.
  showAt: string | null;
  // Ready check: startedAt (null = no check running) + who has confirmed.
  readyCheckAt: string | null;
  readyUserIds: number[];
  // The active code alert (null = all clear). Everyone receives it; clients
  // addressed by targetUserId (or everyone when null) show the banner.
  code: CodeAlert | null;
  depts: { lights: DeptState; audio: DeptState }; // spot is fully derived — no fired state (§5.3)
}

// Elapsed show time in ms for a given wall-clock `now` — the single formula
// shared by every view: pauses freeze the clock, and a stop freezes it at the
// final runtime (a stop during a pause anchors at the pause — the clock was
// already frozen there).
export function timerElapsedMs(
  s: Pick<RoomState, "timerStartedAt" | "timerPausedAt" | "timerPausedMs" | "timerStoppedAt">,
  now: number,
): number {
  if (!s.timerStartedAt) return 0;
  const anchor = s.timerPausedAt
    ? Date.parse(s.timerPausedAt)
    : s.timerStoppedAt
      ? Date.parse(s.timerStoppedAt)
      : now;
  return Math.max(0, anchor - Date.parse(s.timerStartedAt) - (s.timerPausedMs || 0));
}

// ---------------------------------------------------------------------------
// client -> server
// ---------------------------------------------------------------------------

export type C2S =
  | { type: "hb" } // app-level heartbeat, every 10s
  // caller only; throttled <= 1/40ms latest-wins. adminOverride: an ADMIN may
  // move the show position while holding the override key (P) — a temporary
  // hijack; the caller flag itself never moves, so the caller resumes control
  // with their next move.
  | { type: "position"; key: string; idx: number; adminOverride?: boolean }
  // anchorKey (optional): the operator's LOCAL reading line. Sent when the
  // client is disengaged from the caller (or no caller exists) — the server
  // then computes armed/guard from that anchor instead of the global position,
  // so an unhooked operator works exactly as if there were no caller (v1 solo).
  | { type: "go"; dept: "lights" | "audio"; expectedKey: string; force?: boolean; anchorKey?: string } // M2
  | { type: "exitLoop"; dept: "lights" | "audio"; expectedKey: string; anchorKey?: string } // M2
  | { type: "rearm"; dept: "lights" | "audio"; fromKey: string } // M2: clear fired >= fromKey (re-run)
  | { type: "showStart" }
  | { type: "showStop" } // caller or admin: freeze the clock at the final runtime
  | { type: "timerClear" } // caller or admin: wipe a STOPPED timer back to blank
  | { type: "showPause"; resumeInSec?: number } // caller or admin; optional resume countdown
  | { type: "showResume" }
  | { type: "showCountdown"; inSec: number | null } // caller or admin; null clears the pre-show countdown
  | { type: "readyCheck"; action: "start" | "stop" } // caller or admin
  | { type: "ready" } // any crew member: mark yourself ready in the running check
  // Code alerts: anyone raises (to all, or to one person); cleared by the
  // raiser, the caller or an admin.
  | { type: "codeRaise"; level: CodeLevel; msg?: string; targetUserId?: number | null }
  | { type: "codeClear" }
  | { type: "reset" } // caller or admin: v1 Reset (top, clear all fired)
  | { type: "grantCaller"; userId: number } // admin (also available over HTTP)
  | { type: "sync" }; // request full state (client saw a seq gap)

// ---------------------------------------------------------------------------
// server -> client
// ---------------------------------------------------------------------------

export type ErrorCode = "not_caller" | "stale" | "guarded" | "bad_dept" | "locked";

export type S2C =
  | { type: "hb"; t: number } // every 5s; client offline-detects at 12s silence
  | { type: "welcome"; you: UserPublic; state: RoomState; roster: RosterEntry[] }
  | { type: "state"; state: RoomState } // full snapshot (resume, drift repair, reset)
  // byUserId: who moved it — lets the CALLER's client adopt moves made by an
  // admin override (their own echoes are ignored via this id).
  | { type: "position"; seq: number; key: string; idx: number; byUserId: number; clearedFired?: Department[] }
  | {
      type: "fired";
      seq: number;
      dept: Department;
      stopKey: string;
      loopStep?: number;
      entries: FireLogEntry[];
      byUserId: number;
    }
  | { type: "rearmed"; seq: number; dept: Department; firedKeys: string[] }
  | {
      type: "timer";
      startedAt: string | null;
      pausedAt: string | null;
      pausedMs: number;
      resumeAt: string | null;
      stoppedAt: string | null;
      showAt: string | null;
    }
  // Ready-check state (seq-less, also carried in RoomState snapshots).
  | { type: "readyCheck"; at: string | null; ready: number[] }
  // Code alert state (seq-less, also carried in RoomState snapshots). null =
  // cleared / all clear.
  | { type: "code"; code: CodeAlert | null }
  | { type: "roster"; roster: RosterEntry[] } // presence/role/caller changes
  | { type: "callerChanged"; userId: number | null }
  // Seq-LESS spot pre-show flash (§6): the HTTP "Flash" test-fire of a spot cue
  // pulses any connected SpotView addressed by `target` (0 = all spots). Not part
  // of the position/fired seq machine — it carries no show state, only a nudge.
  | { type: "spotFlash"; target: number; preview: string; cueId: number }
  // Live console state (seq-less, informational): the Ion's current active cue,
  // pushed whenever the Eos TCP monitor sees it change. connected=false when
  // the monitor loses the console (cue is then the last-known one, or null).
  | { type: "eosCue"; cue: EosActiveCue | null; connected: boolean }
  | { type: "dataChanged"; scope: "script" | "cues" | "production" } // -> client refetches bundle
  | { type: "kicked" }
  | { type: "error"; code: ErrorCode; msg: string };
