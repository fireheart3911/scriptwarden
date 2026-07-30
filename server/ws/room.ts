// server/ws/room.ts — per-production live show state (§4.3).
//
// One Room per production, created lazily and restored from show_state on first
// access. Holds the server-authoritative RoomState: the caller-owned global
// position, the show timer, and (M2) per-dept fired state. Enforces authority
// (only the caller / admin may mutate) and broadcasts every change through the
// hub. Persists debounced (500ms) and synchronously on shutdown.

import type { ServerWebSocket } from "bun";
import { db, onShutdown, readShowState, writeShowState } from "../db";
import { buildOrder, type OrderEntry } from "../../shared/runningOrder";
import type { Cue, ScriptLine, SongSection } from "../../src/types";
import type {
  CodeAlert,
  Department,
  DeptState,
  ErrorCode,
  FireLogEntry,
  RoomState,
  S2C,
} from "../../shared/protocol";
import {
  applyExitLoop,
  applyFired,
  applyPosition,
  applyRearm,
  armedChanged,
  computeArmed,
  deptCues,
  FIRING_DEPTS,
  isLoopStop,
  type FiringDept,
} from "../../shared/showSync";
import { fireCue, getFireProduction } from "../fire";
import { parseShowSettingsJson, type ShowSettings } from "../../src/lib/showSettings";
import type { UserRow } from "../users";
import { hub, type WsData } from "./hub";

const PERSIST_DEBOUNCE_MS = 500;

function emptyDept(): DeptState {
  return { firedKeys: [], loopKey: null, loopStep: 0 };
}

function initialState(): RoomState {
  return {
    seq: 0,
    callerUserId: null,
    position: { key: "", idx: 0 },
    timerStartedAt: null,
    timerPausedAt: null,
    timerPausedMs: 0,
    timerResumeAt: null,
    timerStoppedAt: null,
    showAt: null,
    readyCheckAt: null,
    readyUserIds: [],
    code: null,
    depts: { lights: emptyDept(), audio: emptyDept() },
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function sendError(ws: ServerWebSocket<WsData>, code: ErrorCode, msg: string): void {
  ws.send(JSON.stringify({ type: "error", code, msg } satisfies S2C));
}

class Room {
  readonly productionId: number;
  readonly state: RoomState;
  private order: OrderEntry[] | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  // Per-dept in-flight lock: the double-fire guard moved server-side (§4.3). A
  // GO sets it while the cue(s) dispatch; a concurrent GO for the same dept gets
  // error{locked}. Dispatch is synchronous today, but this keeps the contract.
  private firing: Record<FiringDept, boolean> = { lights: false, audio: false };

  constructor(productionId: number) {
    this.productionId = productionId;
    this.state = initialState();
    this.restore();
  }

  // --- order cache ----------------------------------------------------------

  getOrder(): OrderEntry[] {
    if (!this.order) this.order = this.buildOrderFromDb();
    return this.order;
  }

  invalidateOrder(): void {
    this.order = null;
    // Re-anchor the stored position against the (about to be rebuilt) order so
    // future snapshots stay consistent even if the caller never moves again.
    this.resolvePosition();
  }

  private buildOrderFromDb(): OrderEntry[] {
    const lines = db
      .query("SELECT * FROM script_lines WHERE production_id = ? ORDER BY seq, id")
      .all(this.productionId) as ScriptLine[];
    const lineIds = lines.map((l) => l.id);
    const sections = lineIds.length
      ? (db
          .query(
            `SELECT * FROM song_sections WHERE song_line_id IN (${lineIds
              .map(() => "?")
              .join(",")}) ORDER BY seq, id`,
          )
          .all(...lineIds) as SongSection[])
      : [];
    const cues = db
      .query("SELECT * FROM cues WHERE production_id = ? ORDER BY id")
      .all(this.productionId) as Cue[];
    return buildOrder(lines, sections, cues);
  }

  // Re-anchor position.idx from position.key against the current order. If the
  // key still exists, adopt its index. If it vanished (edited/deleted), keep the
  // idx clamped and adopt whatever key now sits there (drift repair).
  private resolvePosition(): void {
    const order = this.getOrder();
    if (!order.length) return;
    const key = this.state.position.key;
    const found = key ? order.findIndex((e) => e.key === key) : -1;
    if (found >= 0) {
      this.state.position.idx = found;
    } else {
      const idx = clamp(this.state.position.idx, 0, order.length - 1);
      this.state.position = { key: order[idx].key, idx };
    }
  }

  // --- persistence ----------------------------------------------------------

  private restore(): void {
    const raw = readShowState(this.productionId);
    if (!raw) return;
    try {
      const saved = JSON.parse(raw) as Partial<RoomState>;
      if (typeof saved.seq === "number") this.state.seq = saved.seq;
      if (saved.callerUserId === null || typeof saved.callerUserId === "number") {
        this.state.callerUserId = saved.callerUserId;
      }
      if (saved.position && typeof saved.position.key === "string") {
        this.state.position = {
          key: saved.position.key,
          idx: typeof saved.position.idx === "number" ? saved.position.idx : 0,
        };
      }
      if (saved.timerStartedAt === null || typeof saved.timerStartedAt === "string") {
        this.state.timerStartedAt = saved.timerStartedAt;
      }
      // Pause fields are absent in pre-pause snapshots — default to "running".
      this.state.timerPausedAt =
        typeof saved.timerPausedAt === "string" ? saved.timerPausedAt : null;
      this.state.timerPausedMs =
        typeof saved.timerPausedMs === "number" ? saved.timerPausedMs : 0;
      this.state.timerResumeAt =
        typeof saved.timerResumeAt === "string" ? saved.timerResumeAt : null;
      this.state.timerStoppedAt =
        typeof saved.timerStoppedAt === "string" ? saved.timerStoppedAt : null;
      this.state.showAt = typeof saved.showAt === "string" ? saved.showAt : null;
      this.state.readyCheckAt =
        typeof saved.readyCheckAt === "string" ? saved.readyCheckAt : null;
      this.state.readyUserIds = Array.isArray(saved.readyUserIds)
        ? saved.readyUserIds.filter((n) => typeof n === "number")
        : [];
      this.state.code = normalizeCode(saved.code);
      if (saved.depts) {
        this.state.depts = {
          lights: normalizeDept(saved.depts.lights),
          audio: normalizeDept(saved.depts.audio),
        };
      }
    } catch (e) {
      console.error(`[room ${this.productionId}] failed to restore show_state`, e);
      return;
    }
    // Re-resolve the persisted position key against the live order.
    this.resolvePosition();
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  // Synchronous flush — used by the shutdown hook and can be called any time.
  persistNow(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.resolvePosition();
    try {
      writeShowState(this.productionId, JSON.stringify(this.state));
    } catch (e) {
      console.error(`[room ${this.productionId}] persist failed`, e);
    }
  }

  // --- snapshots ------------------------------------------------------------

  // Always re-anchor the position before handing out a snapshot so welcome /
  // sync / state replies are consistent with the current order.
  snapshot(): RoomState {
    this.resolvePosition();
    return this.state;
  }

  // --- authority helpers ----------------------------------------------------

  private isCaller(user: UserRow): boolean {
    return this.state.callerUserId === user.id;
  }
  private isAdmin(user: UserRow): boolean {
    return !!user.is_admin;
  }

  // --- caller ---------------------------------------------------------------

  // Grant caller if currently vacant (used at join for role === 'caller').
  // Returns true if this user now holds it. Broadcasts on change.
  claimCallerIfVacant(userId: number): boolean {
    if (this.state.callerUserId === null) {
      this.state.callerUserId = userId;
      this.broadcastCallerChanged();
      this.schedulePersist();
      return true;
    }
    return this.state.callerUserId === userId;
  }

  // Force-set the caller (admin grant / transfer). null clears it.
  setCaller(userId: number | null): void {
    if (this.state.callerUserId === userId) return;
    this.state.callerUserId = userId;
    this.broadcastCallerChanged();
    this.schedulePersist();
  }

  private broadcastCallerChanged(): void {
    hub.broadcast(this.productionId, { type: "callerChanged", userId: this.state.callerUserId });
    hub.broadcastRoster(this.productionId);
  }

  // --- message handlers (M1 subset) -----------------------------------------

  handlePosition(
    user: UserRow,
    key: string,
    idx: number,
    ws: ServerWebSocket<WsData>,
    adminOverride = false,
  ): void {
    // The caller owns the position; an ADMIN may temporarily override it (the
    // client sends adminOverride while the operator holds the override key).
    // The caller flag itself never moves — the caller resumes with their next
    // move, which makes the hijack naturally temporary.
    if (!this.isCaller(user) && !(adminOverride && this.isAdmin(user))) {
      sendError(ws, "not_caller", "you are not the caller");
      return;
    }
    const order = this.getOrder();
    // Resolve the incoming key to a canonical (key, idx) against the live order
    // (drift repair for mid-show edits); fall back to the clamped idx if the key
    // has vanished.
    let rKey = key;
    let rIdx = idx;
    if (order.length) {
      const found = key ? order.findIndex((e) => e.key === key) : -1;
      if (found >= 0) {
        rKey = key;
        rIdx = found;
      } else {
        rIdx = clamp(idx, 0, order.length - 1);
        rKey = order[rIdx].key;
      }
    } else {
      rIdx = 0;
    }

    // Move + (on a backward move with rewindRearm ON) re-arm the fired stops
    // at/after the new position, reporting which depts were affected (§5.1).
    const rewindRearm = this.getSettings().rewindRearm;
    const { state: ns, clearedFired } = applyPosition(order, this.state, rKey, rIdx, rewindRearm);
    this.state.position = ns.position;
    this.state.depts = ns.depts;
    // Reset any loop whose armed key just moved away (§5.1 loopStep reset).
    this.syncLoops(order);

    this.state.seq++;
    hub.broadcast(this.productionId, {
      type: "position",
      seq: this.state.seq,
      key: this.state.position.key,
      idx: this.state.position.idx,
      byUserId: user.id,
      ...(clearedFired.length ? { clearedFired } : {}),
    });
    this.schedulePersist();
  }

  // --- fire orchestration (§4.3 / §5.2) -------------------------------------

  // Per-production smart settings (goGuard, rewindRearm, …) parsed from the
  // productions.settings JSON — enforced server-side now, not client-only.
  private getSettings(): ShowSettings {
    const row = db
      .query("SELECT settings FROM productions WHERE id = ?")
      .get(this.productionId) as { settings: string } | null;
    return parseShowSettingsJson(row?.settings ?? "{}");
  }

  // Recompute each firing dept's armed stop and drop loop state whose armed key
  // has moved away (keeps loopStep honest after any position/fired-set change).
  private syncLoops(order: OrderEntry[]): void {
    for (const dept of FIRING_DEPTS) {
      const armedIdx = computeArmed(order, dept, this.state.position.idx, this.state.depts[dept].firedKeys);
      const armedKey = armedIdx >= 0 ? order[armedIdx].key : "";
      this.state.depts = armedChanged(this.state, dept, armedKey).depts;
    }
  }

  private sendSnapshot(ws: ServerWebSocket<WsData>): void {
    ws.send(JSON.stringify({ type: "state", state: this.snapshot() } satisfies S2C));
  }

  // Role gate for go/exitLoop/rearm: the dept must be firable (lights/audio) and
  // the user must operate it (or be an admin). Returns the narrowed dept or null
  // (after sending the appropriate error).
  private checkFireDept(
    user: UserRow,
    dept: Department,
    ws: ServerWebSocket<WsData>,
  ): FiringDept | null {
    if (dept !== "lights" && dept !== "audio") {
      sendError(ws, "bad_dept", `department "${dept}" cannot be fired here`);
      return null;
    }
    if (user.role !== dept && !this.isAdmin(user)) {
      sendError(ws, "bad_dept", `you do not operate ${dept}`);
      return null;
    }
    return dept;
  }

  // The position basis for computeArmed/goGuard: the room's global position,
  // OR — when the client sent an anchorKey (operator disengaged from the
  // caller / no caller) — the operator's own reading line, so an unhooked
  // operator behaves exactly as if there were no caller (v1 solo semantics).
  private resolveBasisIdx(order: OrderEntry[], anchorKey: string | undefined): number {
    if (anchorKey) {
      const i = order.findIndex((e) => e.key === anchorKey);
      if (i >= 0) return i;
    }
    return this.state.position.idx;
  }

  // go{dept, expectedKey, force, anchorKey?}: recompute armed with the CURRENT
  // state; reject a stale expectedKey (+ snapshot); honour the per-dept
  // in-flight lock and the goGuard (unless force). A loop stop fires exactly
  // ONE cue at loopStep % n and stays armed; a normal stop fires ALL its dept
  // cues and is marked fired.
  handleGo(
    user: UserRow,
    dept: Department,
    expectedKey: string,
    force: boolean,
    ws: ServerWebSocket<WsData>,
    anchorKey?: string,
  ): void {
    const d = this.checkFireDept(user, dept, ws);
    if (!d) return;
    if (this.firing[d]) {
      sendError(ws, "locked", `a ${d} cue is already firing`);
      return;
    }
    const order = this.getOrder();
    const posIdx = this.resolveBasisIdx(order, anchorKey);
    const ds = this.state.depts[d];
    const armedIdx = computeArmed(order, d, posIdx, ds.firedKeys);
    const armedKey = armedIdx >= 0 ? order[armedIdx].key : "";
    if (armedKey !== expectedKey) {
      sendError(ws, "stale", "armed cue changed — resyncing");
      this.sendSnapshot(ws);
      return;
    }

    const settings = this.getSettings();
    if (!force && settings.goGuard > 0 && armedIdx - posIdx > settings.goGuard) {
      sendError(ws, "guarded", `armed cue is ${armedIdx - posIdx} stops ahead (guard ${settings.goGuard})`);
      return;
    }

    const entry = order[armedIdx];
    const cues = deptCues(entry, d);
    if (cues.length === 0) {
      // Shouldn't happen (armed requires a dept cue), but never fire nothing.
      sendError(ws, "stale", "no cues at the armed stop");
      this.sendSnapshot(ws);
      return;
    }
    const production = getFireProduction(this.productionId);
    if (!production) {
      sendError(ws, "bad_dept", "production not found");
      return;
    }

    const loop = isLoopStop(entry);
    const entries: FireLogEntry[] = [];
    this.firing[d] = true;
    try {
      if (loop) {
        const n = cues.length;
        const which = ((ds.loopStep % n) + n) % n; // safe modulo (loopStep >= 0)
        entries.push(fireCue(cues[which], production));
      } else {
        for (const cue of cues) entries.push(fireCue(cue, production));
      }
    } finally {
      this.firing[d] = false;
    }

    this.state.depts = applyFired(this.state, d, armedKey, loop).depts;
    this.state.seq++;
    hub.broadcast(this.productionId, {
      type: "fired",
      seq: this.state.seq,
      dept: d,
      stopKey: armedKey,
      entries,
      byUserId: user.id,
      ...(loop ? { loopStep: this.state.depts[d].loopStep } : {}),
    });
    this.schedulePersist();
  }

  // exitLoop{dept, expectedKey}: mark the armed loop stop fired (append to
  // firedKeys, clear loop) so the pointer advances — no cue fires. Broadcasts
  // rearmed (a fired-set change, seq-carrying).
  handleExitLoop(
    user: UserRow,
    dept: Department,
    expectedKey: string,
    ws: ServerWebSocket<WsData>,
    anchorKey?: string,
  ): void {
    const d = this.checkFireDept(user, dept, ws);
    if (!d) return;
    const order = this.getOrder();
    const ds = this.state.depts[d];
    const armedIdx = computeArmed(order, d, this.resolveBasisIdx(order, anchorKey), ds.firedKeys);
    const armedKey = armedIdx >= 0 ? order[armedIdx].key : "";
    if (armedKey !== expectedKey) {
      sendError(ws, "stale", "armed cue changed — resyncing");
      this.sendSnapshot(ws);
      return;
    }
    this.state.depts = applyExitLoop(this.state, d, armedKey).depts;
    this.state.seq++;
    hub.broadcast(this.productionId, {
      type: "rearmed",
      seq: this.state.seq,
      dept: d,
      firedKeys: [...this.state.depts[d].firedKeys],
    });
    this.schedulePersist();
  }

  // rearm{dept, fromKey}: "Re-arm from here" — drop every fired key at/after
  // fromKey so those stops arm again on the next pass. Broadcasts rearmed.
  handleRearm(
    user: UserRow,
    dept: Department,
    fromKey: string,
    ws: ServerWebSocket<WsData>,
  ): void {
    const d = this.checkFireDept(user, dept, ws);
    if (!d) return;
    const order = this.getOrder();
    const fromIdx = order.findIndex((e) => e.key === fromKey);
    if (fromIdx < 0) {
      sendError(ws, "stale", "unknown re-arm anchor — resyncing");
      this.sendSnapshot(ws);
      return;
    }
    this.state.depts = applyRearm(order, this.state, d, fromIdx).depts;
    this.syncLoops(order);
    this.state.seq++;
    hub.broadcast(this.productionId, {
      type: "rearmed",
      seq: this.state.seq,
      dept: d,
      firedKeys: [...this.state.depts[d].firedKeys],
    });
    this.schedulePersist();
  }

  private broadcastTimer(): void {
    hub.broadcast(this.productionId, {
      type: "timer",
      startedAt: this.state.timerStartedAt,
      pausedAt: this.state.timerPausedAt,
      pausedMs: this.state.timerPausedMs,
      resumeAt: this.state.timerResumeAt,
      stoppedAt: this.state.timerStoppedAt,
      showAt: this.state.showAt,
    });
    this.schedulePersist();
  }

  private mayControlTimer(user: UserRow, ws: ServerWebSocket<WsData>, verb: string): boolean {
    if (!this.isCaller(user) && !this.isAdmin(user)) {
      sendError(ws, "not_caller", `only the caller or an admin can ${verb} the show`);
      return false;
    }
    return true;
  }

  handleShowStart(user: UserRow, ws: ServerWebSocket<WsData>): void {
    if (!this.mayControlTimer(user, ws, "start")) return;
    this.state.timerStartedAt = new Date().toISOString();
    this.state.timerPausedAt = null;
    this.state.timerPausedMs = 0;
    this.state.timerResumeAt = null;
    this.state.timerStoppedAt = null; // starting the next show discards the old final time
    this.state.showAt = null; // the show is starting — countdown fulfilled
    this.broadcastTimer();
  }

  // Stop freezes the clock at the final runtime instead of wiping it — the
  // frozen time stays on every screen until an explicit timerClear or the next
  // showStart. A stop during a pause keeps the pause fields so the elapsed
  // formula stays anchored at the pause (the clock was already frozen there).
  handleShowStop(user: UserRow, ws: ServerWebSocket<WsData>): void {
    if (!this.mayControlTimer(user, ws, "stop")) return;
    if (!this.state.timerStartedAt || this.state.timerStoppedAt) return; // not running / already stopped
    this.state.timerStoppedAt = new Date().toISOString();
    this.state.timerResumeAt = null;
    this.state.showAt = null;
    this.broadcastTimer();
  }

  // Wipe a stopped timer back to ––:––:––. Refused while the clock is live so a
  // stray clear can never lose the running epoch mid-show.
  handleTimerClear(user: UserRow, ws: ServerWebSocket<WsData>): void {
    if (!this.mayControlTimer(user, ws, "clear the timer of")) return;
    if (this.state.timerStartedAt && !this.state.timerStoppedAt) return; // live — stop first
    this.state.timerStartedAt = null;
    this.state.timerPausedAt = null;
    this.state.timerPausedMs = 0;
    this.state.timerResumeAt = null;
    this.state.timerStoppedAt = null;
    this.broadcastTimer();
  }

  // Pre-show countdown: an informational "show starts at" target shown to
  // everyone while the timer isn't running. null clears it. Does NOT start
  // the timer — showtime stays a deliberate button press.
  handleShowCountdown(user: UserRow, inSec: number | null, ws: ServerWebSocket<WsData>): void {
    if (!this.mayControlTimer(user, ws, "set a countdown for")) return;
    const s = Math.trunc(Number(inSec) || 0);
    this.state.showAt = s > 0 ? new Date(Date.now() + s * 1000).toISOString() : null;
    this.broadcastTimer();
  }

  // --- ready check ------------------------------------------------------------

  private broadcastReadyCheck(): void {
    hub.broadcast(this.productionId, {
      type: "readyCheck",
      at: this.state.readyCheckAt,
      ready: [...this.state.readyUserIds],
    });
    this.schedulePersist();
  }

  handleReadyCheck(user: UserRow, action: "start" | "stop", ws: ServerWebSocket<WsData>): void {
    if (!this.isCaller(user) && !this.isAdmin(user)) {
      sendError(ws, "not_caller", "only the caller or an admin can run a ready check");
      return;
    }
    if (action === "start") {
      this.state.readyCheckAt = new Date().toISOString();
      this.state.readyUserIds = [];
    } else {
      this.state.readyCheckAt = null;
      this.state.readyUserIds = [];
    }
    this.broadcastReadyCheck();
  }

  // Any crew member confirms readiness in the running check.
  handleReady(user: UserRow): void {
    if (!this.state.readyCheckAt) return;
    if (this.state.readyUserIds.includes(user.id)) return;
    this.state.readyUserIds = [...this.state.readyUserIds, user.id];
    this.broadcastReadyCheck();
  }

  // --- code alerts ------------------------------------------------------------

  private broadcastCode(): void {
    hub.broadcast(this.productionId, {
      type: "code",
      code: this.state.code ? { ...this.state.code } : null,
    });
    this.schedulePersist();
  }

  // ANY crew member may raise a code — a spot op on a catwalk sees things the
  // booth can't. One code at a time; a new raise replaces the current one
  // (yellow → red escalation, or a corrected message).
  handleCodeRaise(
    user: UserRow,
    level: unknown,
    msg: unknown,
    targetUserId: unknown,
    ws: ServerWebSocket<WsData>,
  ): void {
    if (level !== "yellow" && level !== "red") {
      sendError(ws, "bad_dept", `unknown code level "${String(level)}"`);
      return;
    }
    let target: number | null = null;
    if (typeof targetUserId === "number" && targetUserId > 0) {
      const row = db
        .query("SELECT id FROM users WHERE id = ? AND production_id = ? AND revoked = 0")
        .get(targetUserId, this.productionId) as { id: number } | null;
      if (!row) {
        sendError(ws, "bad_dept", "no such crew member to address the code to");
        return;
      }
      target = row.id;
    }
    this.state.code = {
      level,
      msg: typeof msg === "string" ? msg.trim().slice(0, 200) : "",
      targetUserId: target,
      byUserId: user.id,
      byName: user.name,
      at: new Date().toISOString(),
    };
    this.broadcastCode();
  }

  // Cleared by the raiser, the caller or an admin ("situation resolved").
  handleCodeClear(user: UserRow, ws: ServerWebSocket<WsData>): void {
    if (!this.state.code) return;
    if (this.state.code.byUserId !== user.id && !this.isCaller(user) && !this.isAdmin(user)) {
      sendError(ws, "not_caller", "only the raiser, the caller or an admin can clear a code");
      return;
    }
    this.state.code = null;
    this.broadcastCode();
  }

  // Pause the show timer (interval / hold). resumeInSec is an OPTIONAL,
  // informational countdown shown to everyone ("show resumes in m:ss") — the
  // clock stays paused until an explicit showResume.
  handleShowPause(user: UserRow, resumeInSec: number | undefined, ws: ServerWebSocket<WsData>): void {
    if (!this.mayControlTimer(user, ws, "pause")) return;
    if (!this.state.timerStartedAt || this.state.timerPausedAt || this.state.timerStoppedAt)
      return; // not running / already paused / stopped
    const now = Date.now();
    this.state.timerPausedAt = new Date(now).toISOString();
    const s = Math.trunc(Number(resumeInSec) || 0);
    this.state.timerResumeAt = s > 0 ? new Date(now + s * 1000).toISOString() : null;
    this.broadcastTimer();
  }

  handleShowResume(user: UserRow, ws: ServerWebSocket<WsData>): void {
    if (!this.mayControlTimer(user, ws, "resume")) return;
    if (!this.state.timerStartedAt || !this.state.timerPausedAt || this.state.timerStoppedAt)
      return; // not paused (or already stopped for good)
    this.state.timerPausedMs += Math.max(0, Date.now() - Date.parse(this.state.timerPausedAt));
    this.state.timerPausedAt = null;
    this.state.timerResumeAt = null;
    this.broadcastTimer();
  }

  // v1 Reset: position to the top of the show, clear all fired state. Timer is
  // deliberately left untouched (§4.3). Broadcasts a full state snapshot.
  handleReset(user: UserRow, ws: ServerWebSocket<WsData>): void {
    if (!this.isCaller(user) && !this.isAdmin(user)) {
      sendError(ws, "not_caller", "only the caller or an admin can reset");
      return;
    }
    const order = this.getOrder();
    this.state.position = { key: order[0]?.key ?? "", idx: 0 };
    this.state.depts = { lights: emptyDept(), audio: emptyDept() };
    this.state.seq++;
    hub.broadcast(this.productionId, { type: "state", state: this.snapshot() });
    this.schedulePersist();
  }

  handleGrantCaller(user: UserRow, userId: number, ws: ServerWebSocket<WsData>): void {
    if (!this.isAdmin(user)) {
      sendError(ws, "not_caller", "only an admin can grant caller");
      return;
    }
    // Target must be a live, non-revoked user in this production.
    const target = db
      .query("SELECT id FROM users WHERE id = ? AND production_id = ? AND revoked = 0")
      .get(userId, this.productionId) as { id: number } | null;
    if (!target) {
      sendError(ws, "not_caller", "no such user in this production");
      return;
    }
    this.setCaller(userId);
  }

  handleSync(ws: ServerWebSocket<WsData>): void {
    ws.send(JSON.stringify({ type: "state", state: this.snapshot() } satisfies S2C));
  }
}

// Tolerant restore of a persisted code alert (absent in pre-code snapshots).
function normalizeCode(c: unknown): CodeAlert | null {
  if (typeof c !== "object" || c === null) return null;
  const o = c as Partial<CodeAlert>;
  if (o.level !== "yellow" && o.level !== "red") return null;
  if (typeof o.byUserId !== "number") return null;
  return {
    level: o.level,
    msg: typeof o.msg === "string" ? o.msg : "",
    targetUserId: typeof o.targetUserId === "number" ? o.targetUserId : null,
    byUserId: o.byUserId,
    byName: typeof o.byName === "string" ? o.byName : "?",
    at: typeof o.at === "string" ? o.at : new Date().toISOString(),
  };
}

function normalizeDept(d: Partial<DeptState> | undefined): DeptState {
  return {
    firedKeys: Array.isArray(d?.firedKeys) ? d!.firedKeys.filter((k) => typeof k === "string") : [],
    loopKey: typeof d?.loopKey === "string" ? d.loopKey : null,
    loopStep: typeof d?.loopStep === "number" ? d.loopStep : 0,
  };
}

class Rooms {
  private map = new Map<number, Room>();

  get(productionId: number): Room {
    let room = this.map.get(productionId);
    if (!room) {
      room = new Room(productionId);
      this.map.set(productionId, room);
    }
    return room;
  }

  // Peek without creating — for callers/roster building that shouldn't spin up a
  // room just to read a (default) caller id.
  peek(productionId: number): Room | undefined {
    return this.map.get(productionId);
  }

  // Route mutations call this after editing script/cues/production. No-op if the
  // room was never materialised (its order builds fresh on first access anyway).
  invalidateOrder(productionId: number): void {
    this.map.get(productionId)?.invalidateOrder();
  }

  // Called synchronously from the shutdown hook (§4.3).
  persistAllSync(): void {
    for (const room of this.map.values()) room.persistNow();
  }
}

export const rooms = new Rooms();

// Flush all live rooms to show_state on shutdown, alongside the WAL checkpoint.
onShutdown(() => rooms.persistAllSync());
