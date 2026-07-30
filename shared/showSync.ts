// shared/showSync.ts — pure show-state reducers (§5.1 / §5.2).
//
// SINGLE SOURCE OF TRUTH for the armed/fired state machine, imported by BOTH the
// Bun server (server/ws/room.ts, the authority) and — in later milestones — the
// Vite client (for optimistic UI). Everything here is a pure function of its
// arguments: no I/O, no clock, no mutation of the inputs. The only imports are
// shared domain types (OrderEntry from runningOrder, the RoomState family from
// protocol) so this bundles cleanly on both sides.
//
// The model generalises v1's single-pointer show machine to N departments with a
// per-dept fired SET (not a single lastFiredKey), which deliberately fixes the
// v1 quirk where firing 2+ ahead let a cursor nudge re-arm an already-fired stop
// (§5.1). Loop rules are carried verbatim from v1: loops never auto-fire, never
// block movement, and exitLoop marks the loop key fired.

import type { OrderEntry } from "./runningOrder";
import type { Cue } from "../src/types";
import type { Department, DeptState, RoomState } from "./protocol";

// Departments that hold server-side fired/loop state. `spot` is fully derived
// from position (§5.3) so it is intentionally absent from RoomState.depts.
export const FIRING_DEPTS = ["lights", "audio"] as const;
export type FiringDept = (typeof FIRING_DEPTS)[number];

// --- selectors --------------------------------------------------------------

// The cues at `entry` that belong to `dept`. For spot, honour spot_target: a cue
// with target 0 addresses ALL spots, otherwise it addresses exactly spotNo.
// (spotNo is irrelevant for lights/audio and ignored there.)
export function deptCues(entry: OrderEntry, dept: Department, spotNo = 0): Cue[] {
  return entry.cues.filter(
    (c) =>
      c.department === dept &&
      (dept !== "spot" || c.spot_target === 0 || c.spot_target === spotNo),
  );
}

// A stop is a "dept stop" when it carries at least one cue of that department
// (spot filtered by spotNo). This is v1's cueStops generalised per-department.
export function deptStops(order: OrderEntry[], dept: Department, spotNo = 0): OrderEntry[] {
  return order.filter((e) => deptCues(e, dept, spotNo).length > 0);
}

// True when this stop is a LOOP stop (a song section flagged loop=1): GO cycles
// its cues (A/B flares) rather than firing them all and advancing (§5.2).
export function isLoopStop(entry: OrderEntry): boolean {
  return entry.kind === "section" && !!entry.section && entry.section.loop === 1;
}

// --- armed pointer ----------------------------------------------------------

// Index into `order` of the currently-armed dept stop, or -1 if none.
//
// The armed stop is the first dept stop at/after posIdx whose key is NOT in
// firedKeys — EXCEPT the on-position re-arm: if posIdx sits exactly on a dept
// stop, that stop is armed even when already fired (v1's `i === from` click
// re-arm, kept for the position owner, §5.1). Everything strictly after posIdx
// that has already fired is skipped.
//
// The exception deliberately applies to LOOPS too: standing on a previously
// exited loop re-arms it, so a run-through can re-enter last rehearsal's loops
// without a re-arm/rewind. The flip side — "exit while parked ON the loop
// bounces right back" — is handled CLIENT-side: ShowMode steps the reading
// cursor off the loop after a successful exit (same as firing a cue does).
export function computeArmed(
  order: OrderEntry[],
  dept: Department,
  posIdx: number,
  firedKeys: Iterable<string>,
  spotNo = 0,
): number {
  const fired = firedKeys instanceof Set ? firedKeys : new Set(firedKeys);
  for (let i = Math.max(0, posIdx); i < order.length; i++) {
    const e = order[i];
    if (deptCues(e, dept, spotNo).length === 0) continue;
    if (i === posIdx) return i; // on-position re-arm exception (fired or not)
    if (!fired.has(e.key)) return i;
  }
  return -1;
}

// --- position + spot derivation --------------------------------------------

// Resolve a caller position (key primary, idx advisory) to a local order index.
// The key wins when it still resolves (stable across mid-show edits); otherwise
// the advisory idx is clamped into range. -1 for an empty order. Shared by both
// ShowMode and SpotView so every client reads the global position identically.
export function resolvePosIdx(order: OrderEntry[], key: string, idx: number): number {
  if (order.length === 0) return -1;
  if (key) {
    const f = order.findIndex((e) => e.key === key);
    if (f >= 0) return f;
  }
  return Math.max(0, Math.min(order.length - 1, idx));
}

// Spot ACTIVE stop (§5.3): the LAST spot stop at/before posIdx addressed to this
// spot (target 0 or spotNo). -1 when none yet. Position-derived — spot holds no
// fired state, so the active instruction is simply "the most recent spot cue the
// show has reached".
export function spotActive(order: OrderEntry[], spotNo: number, posIdx: number): number {
  let found = -1;
  const hi = Math.min(posIdx, order.length - 1);
  for (let i = 0; i <= hi; i++) {
    if (deptCues(order[i], "spot", spotNo).length > 0) found = i;
  }
  return found;
}

// Spot STANDBY stop (§5.3): the FIRST spot stop strictly after posIdx addressed
// to this spot. -1 when none remain.
export function spotStandby(order: OrderEntry[], spotNo: number, posIdx: number): number {
  for (let i = Math.max(0, posIdx + 1); i < order.length; i++) {
    if (deptCues(order[i], "spot", spotNo).length > 0) return i;
  }
  return -1;
}

// The spot cue at `entry` most specific to this operator: a cue targeting exactly
// spotNo wins over an ALL-spots (target 0) cue at the same stop. Undefined when
// the stop carries no spot cue for this operator.
export function spotCueFor(entry: OrderEntry, spotNo: number): Cue | undefined {
  const cues = deptCues(entry, "spot", spotNo);
  if (cues.length === 0) return undefined;
  return cues.find((c) => c.spot_target === spotNo) ?? cues[0];
}

// Hotkey helper (M3 reuse): next index strictly after `from` whose entry matches
// `pred`, or -1. e.g. next song line, next cue-bearing stop.
export function nextOfType(
  order: OrderEntry[],
  from: number,
  pred: (e: OrderEntry) => boolean,
): number {
  for (let i = from + 1; i < order.length; i++) {
    if (pred(order[i])) return i;
  }
  return -1;
}

// --- reducers (pure: return a new RoomState, never mutate the input) --------

function cloneDept(d: DeptState): DeptState {
  return { firedKeys: [...d.firedKeys], loopKey: d.loopKey, loopStep: d.loopStep };
}

// Move the global position to (key, idx). When rewindRearm is on AND this is a
// backward move (new idx < old idx), re-arm the stops at/after the new position
// by dropping, from every firing dept, the fired keys whose stop index is >= the
// new idx (§5.1: "caller rewind clears firedKeys at/after the new position").
// Returns the affected departments in clearedFired so the position broadcast can
// carry it (§4.2). Fired keys that no longer resolve to an order index (edited
// away) are conservatively kept.
export function applyPosition(
  order: OrderEntry[],
  state: RoomState,
  key: string,
  idx: number,
  rewindRearm: boolean,
): { state: RoomState; clearedFired: Department[] } {
  const oldIdx = state.position.idx;
  const backward = idx < oldIdx;
  const next: RoomState = {
    ...state,
    position: { key, idx },
    depts: { lights: state.depts.lights, audio: state.depts.audio },
  };
  const clearedFired: Department[] = [];

  if (rewindRearm && backward) {
    const indexByKey = new Map<string, number>();
    for (let i = 0; i < order.length; i++) indexByKey.set(order[i].key, i);
    for (const dept of FIRING_DEPTS) {
      const ds = state.depts[dept];
      const kept = ds.firedKeys.filter((k) => {
        const ki = indexByKey.get(k);
        return ki === undefined ? true : ki < idx;
      });
      if (kept.length !== ds.firedKeys.length) {
        clearedFired.push(dept);
        next.depts[dept] = { ...cloneDept(ds), firedKeys: kept };
      }
    }
  }
  return { state: next, clearedFired };
}

// Record a GO on `stopKey` for `dept`.
//   loop  => keep it armed: set loopKey=stopKey, loopStep+1, DON'T add to
//            firedKeys (so a repeat GO cycles the next cue).
//   normal => append stopKey to firedKeys (dedup) and clear loop state.
// The caller fires the cue(s) at the CURRENT loopStep before calling this; the
// increment here is what makes the next GO advance A→B→A… (§4.3 / §5.2).
export function applyFired(
  state: RoomState,
  dept: FiringDept,
  stopKey: string,
  isLoop: boolean,
): RoomState {
  const ds = state.depts[dept];
  const nd: DeptState = isLoop
    ? { firedKeys: [...ds.firedKeys], loopKey: stopKey, loopStep: ds.loopStep + 1 }
    : {
        firedKeys: ds.firedKeys.includes(stopKey) ? [...ds.firedKeys] : [...ds.firedKeys, stopKey],
        loopKey: null,
        loopStep: 0,
      };
  return { ...state, depts: { ...state.depts, [dept]: nd } };
}

// exitLoop / re-arm-from-here mark: append stopKey to a dept's firedKeys and
// clear its loop state, without firing anything. (This is exactly applyFired's
// non-loop branch; named separately for intent at the call sites in room.ts.)
export function applyExitLoop(state: RoomState, dept: FiringDept, stopKey: string): RoomState {
  return applyFired(state, dept, stopKey, false);
}

// Re-arm a dept from `fromIdx`: drop every fired key whose stop index is >=
// fromIdx (so those stops arm again on the next pass). Keys that no longer
// resolve are kept. Used by the explicit "Re-arm from here" op (§4.2 rearm).
export function applyRearm(
  order: OrderEntry[],
  state: RoomState,
  dept: FiringDept,
  fromIdx: number,
): RoomState {
  const indexByKey = new Map<string, number>();
  for (let i = 0; i < order.length; i++) indexByKey.set(order[i].key, i);
  const ds = state.depts[dept];
  const kept = ds.firedKeys.filter((k) => {
    const ki = indexByKey.get(k);
    return ki === undefined ? true : ki < fromIdx;
  });
  return { ...state, depts: { ...state.depts, [dept]: { ...cloneDept(ds), firedKeys: kept } } };
}

// Loop-reset bookkeeping (§5.1: "loopStep resets when that dept's armed key
// changes"). Whenever a dept's armed key moves AWAY from the stop it was
// cycling, drop the loop state. No-op when still parked on the same loop (so a
// repeat GO keeps cycling) or when there was no loop active. Pass "" for
// newArmedKey when nothing is armed.
export function armedChanged(state: RoomState, dept: FiringDept, newArmedKey: string): RoomState {
  const ds = state.depts[dept];
  if (ds.loopKey !== null && ds.loopKey !== newArmedKey) {
    return { ...state, depts: { ...state.depts, [dept]: { ...cloneDept(ds), loopKey: null, loopStep: 0 } } };
  }
  return state;
}
