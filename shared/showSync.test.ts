// shared/showSync.test.ts — unit tests for the pure show-state reducers (§5.2).
//
// Run: bun test  (from v2/). Uses a tiny synthetic order[] fixture built here —
// deliberately NOT the DB — so the state machine is tested in isolation.

import { test, expect } from "bun:test";
import type { Cue, Department, ScriptLine, SongSection } from "../src/types";
import type { RoomState } from "./protocol";
import type { OrderEntry } from "./runningOrder";
import {
  applyExitLoop,
  applyFired,
  applyPosition,
  applyRearm,
  armedChanged,
  computeArmed,
  deptCues,
  deptStops,
  isLoopStop,
  nextOfType,
  resolvePosIdx,
  spotActive,
  spotCueFor,
  spotStandby,
} from "./showSync";

// --- fixture builders -------------------------------------------------------

let nextCueId = 1;
function mkCue(dept: Department, extra: Partial<Cue> = {}): Cue {
  return {
    id: nextCueId++,
    production_id: 1,
    anchor_type: "line",
    anchor_id: 0,
    cue_list: 1,
    cue_number: String(nextCueId),
    label: "",
    notes: "",
    fire_mode: "fire",
    cmd_text: "",
    department: dept,
    spot_target: 0,
    avantis_scene: 0,
    spot_pickup: "",
    spot_color: "",
    spot_size: "",
    ...extra,
  };
}

function mkLine(id: number): ScriptLine {
  return {
    id,
    production_id: 1,
    seq: id,
    type: "dialogue",
    speaker: "",
    text: "",
    note: "",
    color_override: null,
  };
}

function mkSection(id: number, loop: number): SongSection {
  return { id, song_line_id: 1, seq: id, label: "", note: "", lyrics: "", loop };
}

function lineEntry(key: string, cues: Cue[]): OrderEntry {
  return { key, kind: "line", line: mkLine(1), cues };
}

function loopEntry(key: string, cues: Cue[]): OrderEntry {
  return { key, kind: "section", line: mkLine(1), section: mkSection(1, 1), cues };
}

function mkState(over: Partial<RoomState> = {}): RoomState {
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
    depts: {
      lights: { firedKeys: [], loopKey: null, loopStep: 0 },
      audio: { firedKeys: [], loopKey: null, loopStep: 0 },
    },
    ...over,
  };
}

const keys = (entries: OrderEntry[]) => entries.map((e) => e.key);

// ---------------------------------------------------------------------------
// computeArmed — fired-set skip
// ---------------------------------------------------------------------------

test("computeArmed skips fired stops (fired-set, not single lastFired)", () => {
  // idx0 is a non-cue gap so posIdx=0 exercises the "look ahead" path.
  const order: OrderEntry[] = [
    lineEntry("x0", []),
    lineEntry("a", [mkCue("lights")]),
    lineEntry("b", [mkCue("lights")]),
    lineEntry("c", [mkCue("lights")]),
  ];
  expect(computeArmed(order, "lights", 0, [])).toBe(1); // first lights stop
  expect(computeArmed(order, "lights", 0, ["a"])).toBe(2); // skip a
  expect(computeArmed(order, "lights", 0, ["a", "b"])).toBe(3); // skip a,b
  expect(computeArmed(order, "lights", 0, ["a", "b", "c"])).toBe(-1); // all fired
  // A Set is accepted as well as an array.
  expect(computeArmed(order, "lights", 0, new Set(["a"]))).toBe(2);
});

// ---------------------------------------------------------------------------
// computeArmed — on-position re-arm exception (v1 `i === from`)
// ---------------------------------------------------------------------------

test("computeArmed re-arms a fired stop when position sits exactly on it", () => {
  const order: OrderEntry[] = [
    lineEntry("x0", []),
    lineEntry("a", [mkCue("lights")]),
    lineEntry("b", [mkCue("lights")]),
    lineEntry("c", [mkCue("lights")]),
  ];
  // posIdx exactly on a fired stop → re-arm it (exception).
  expect(computeArmed(order, "lights", 1, ["a"])).toBe(1);
  // Even when later stops are also fired, on-position wins over the skip.
  expect(computeArmed(order, "lights", 1, ["a", "b"])).toBe(1);
  // Strictly-before a fired stop still skips it (no exception off-position).
  expect(computeArmed(order, "lights", 0, ["a"])).toBe(2);
});

test("computeArmed re-arms a fired (exited) LOOP on-position — run-through re-entry", () => {
  // Standing on a loop that was exited in an earlier run re-arms it, so a new
  // run-through re-enters last rehearsal's loops without a re-arm/rewind. The
  // "exit bounces back while parked on it" side is solved in ShowMode by
  // stepping the reading cursor off the loop after a successful exit.
  const order: OrderEntry[] = [
    lineEntry("x0", []),
    loopEntry("L", [mkCue("lights"), mkCue("lights")]),
    lineEntry("b", [mkCue("lights")]),
  ];
  // Unfired loop arms normally, on-position or ahead.
  expect(computeArmed(order, "lights", 1, [])).toBe(1);
  expect(computeArmed(order, "lights", 0, [])).toBe(1);
  // Exited loop, position ON it → re-armed (NOT skipped ahead).
  expect(computeArmed(order, "lights", 1, ["L"])).toBe(1);
  // Exited loop, position BEFORE it → skipped (fired-set), next unfired wins.
  expect(computeArmed(order, "lights", 0, ["L"])).toBe(2);
});

// ---------------------------------------------------------------------------
// applyPosition — rewind re-arm on / off
// ---------------------------------------------------------------------------

test("applyPosition rewind re-arm clears fired at/after the new position when ON", () => {
  const order: OrderEntry[] = [
    lineEntry("x0", []),
    lineEntry("a", [mkCue("lights")]),
    lineEntry("b", [mkCue("lights")]),
    lineEntry("c", [mkCue("lights")]),
  ];
  const state = mkState({
    position: { key: "c", idx: 3 },
    depts: {
      lights: { firedKeys: ["a", "b", "c"], loopKey: null, loopStep: 0 },
      audio: { firedKeys: [], loopKey: null, loopStep: 0 },
    },
  });
  // Rewind to idx 2 (key b): drop keys at index >= 2 → b,c cleared; a kept.
  const r = applyPosition(order, state, "b", 2, true);
  expect(r.state.depts.lights.firedKeys).toEqual(["a"]);
  expect(r.clearedFired).toEqual(["lights"]);
  // Input state is untouched (purity).
  expect(state.depts.lights.firedKeys).toEqual(["a", "b", "c"]);
});

test("applyPosition rewind re-arm is a no-op when OFF", () => {
  const order: OrderEntry[] = [
    lineEntry("x0", []),
    lineEntry("a", [mkCue("lights")]),
    lineEntry("b", [mkCue("lights")]),
    lineEntry("c", [mkCue("lights")]),
  ];
  const state = mkState({
    position: { key: "c", idx: 3 },
    depts: {
      lights: { firedKeys: ["a", "b", "c"], loopKey: null, loopStep: 0 },
      audio: { firedKeys: [], loopKey: null, loopStep: 0 },
    },
  });
  const r = applyPosition(order, state, "b", 2, false);
  expect(r.state.depts.lights.firedKeys).toEqual(["a", "b", "c"]);
  expect(r.clearedFired).toEqual([]);
});

test("applyPosition forward move never re-arms even with rewindRearm ON", () => {
  const order: OrderEntry[] = [
    lineEntry("x0", []),
    lineEntry("a", [mkCue("lights")]),
    lineEntry("b", [mkCue("lights")]),
    lineEntry("c", [mkCue("lights")]),
  ];
  const state = mkState({
    position: { key: "a", idx: 1 },
    depts: {
      lights: { firedKeys: ["a"], loopKey: null, loopStep: 0 },
      audio: { firedKeys: [], loopKey: null, loopStep: 0 },
    },
  });
  const r = applyPosition(order, state, "c", 3, true);
  expect(r.state.depts.lights.firedKeys).toEqual(["a"]);
  expect(r.clearedFired).toEqual([]);
});

test("applyPosition rewind re-arm spans every firing dept it clears", () => {
  const order: OrderEntry[] = [
    lineEntry("a", [mkCue("lights")]),
    lineEntry("b", [mkCue("audio")]),
    lineEntry("c", [mkCue("lights")]),
    lineEntry("d", [mkCue("audio")]),
  ];
  const state = mkState({
    position: { key: "d", idx: 3 },
    depts: {
      lights: { firedKeys: ["a", "c"], loopKey: null, loopStep: 0 },
      audio: { firedKeys: ["b", "d"], loopKey: null, loopStep: 0 },
    },
  });
  // Rewind to idx 1 → keep index<1: lights keeps a(0); audio keeps nothing.
  const r = applyPosition(order, state, "b", 1, true);
  expect(r.state.depts.lights.firedKeys).toEqual(["a"]);
  expect(r.state.depts.audio.firedKeys).toEqual([]);
  expect(r.clearedFired.sort()).toEqual(["audio", "lights"]);
});

// ---------------------------------------------------------------------------
// Loop step / reset + exitLoop
// ---------------------------------------------------------------------------

test("applyFired on a loop increments loopStep, sets loopKey, and does NOT fire-set it", () => {
  const state = mkState();
  const s1 = applyFired(state, "lights", "L", true);
  expect(s1.depts.lights).toEqual({ firedKeys: [], loopKey: "L", loopStep: 1 });
  const s2 = applyFired(s1, "lights", "L", true);
  expect(s2.depts.lights).toEqual({ firedKeys: [], loopKey: "L", loopStep: 2 });
});

test("applyFired on a normal stop appends to firedKeys (dedup) and clears loop", () => {
  const state = mkState({
    depts: {
      lights: { firedKeys: [], loopKey: "L", loopStep: 3 },
      audio: { firedKeys: [], loopKey: null, loopStep: 0 },
    },
  });
  const s1 = applyFired(state, "lights", "a", false);
  expect(s1.depts.lights).toEqual({ firedKeys: ["a"], loopKey: null, loopStep: 0 });
  // Re-firing the same key (on-position re-arm) does not duplicate it.
  const s2 = applyFired(s1, "lights", "a", false);
  expect(s2.depts.lights.firedKeys).toEqual(["a"]);
});

test("applyExitLoop marks the loop key fired and clears loop state", () => {
  const state = mkState({
    depts: {
      lights: { firedKeys: [], loopKey: "L", loopStep: 2 },
      audio: { firedKeys: [], loopKey: null, loopStep: 0 },
    },
  });
  const s = applyExitLoop(state, "lights", "L");
  expect(s.depts.lights).toEqual({ firedKeys: ["L"], loopKey: null, loopStep: 0 });
});

test("armedChanged resets loopStep only when the armed key moves away from the loop", () => {
  const state = mkState({
    depts: {
      lights: { firedKeys: [], loopKey: "L", loopStep: 2 },
      audio: { firedKeys: [], loopKey: null, loopStep: 0 },
    },
  });
  // Still parked on the same loop → unchanged (repeat GO keeps cycling).
  expect(armedChanged(state, "lights", "L").depts.lights.loopStep).toBe(2);
  // Armed moved to a different stop → loop resets.
  const moved = armedChanged(state, "lights", "c");
  expect(moved.depts.lights).toEqual({ firedKeys: [], loopKey: null, loopStep: 0 });
  // Nothing armed ("") also resets.
  expect(armedChanged(state, "lights", "").depts.lights.loopStep).toBe(0);
});

test("isLoopStop distinguishes loop sections from ordinary stops", () => {
  expect(isLoopStop(loopEntry("L", [mkCue("lights")]))).toBe(true);
  expect(isLoopStop(lineEntry("a", [mkCue("lights")]))).toBe(false);
  // A non-loop section is not a loop stop.
  const sec: OrderEntry = {
    key: "sec",
    kind: "section",
    line: mkLine(1),
    section: mkSection(2, 0),
    cues: [mkCue("lights")],
  };
  expect(isLoopStop(sec)).toBe(false);
});

// ---------------------------------------------------------------------------
// Department isolation
// ---------------------------------------------------------------------------

test("computeArmed keeps lights and audio pointers independent", () => {
  // idx0 is a non-cue gap so posIdx=0 exercises the look-ahead (not the
  // on-position re-arm exception).
  const order: OrderEntry[] = [
    lineEntry("x0", []),
    lineEntry("a", [mkCue("lights")]),
    lineEntry("b", [mkCue("audio")]),
    lineEntry("c", [mkCue("lights")]),
    lineEntry("d", [mkCue("audio")]),
  ];
  // Fresh: each dept arms its own first stop.
  expect(computeArmed(order, "lights", 0, [])).toBe(1); // a
  expect(computeArmed(order, "audio", 0, [])).toBe(2); // b
  // Firing lights (a) advances only the lights pointer; audio is untouched.
  const fired = applyFired(mkState(), "lights", "a", false);
  expect(computeArmed(order, "lights", 0, fired.depts.lights.firedKeys)).toBe(3); // c
  expect(computeArmed(order, "audio", 0, fired.depts.audio.firedKeys)).toBe(2); // still b
  // An audio key in the lights fired-set never affects lights arming.
  expect(computeArmed(order, "lights", 0, ["b"])).toBe(1); // a
});

// ---------------------------------------------------------------------------
// spot_target filtering
// ---------------------------------------------------------------------------

test("deptStops / deptCues filter spot cues by spot_target (0 = all)", () => {
  const order: OrderEntry[] = [
    lineEntry("allspot", [mkCue("spot", { spot_target: 0 })]),
    lineEntry("spot1", [mkCue("spot", { spot_target: 1 })]),
    lineEntry("spot2", [mkCue("spot", { spot_target: 2 })]),
    lineEntry("both", [mkCue("spot", { spot_target: 1 }), mkCue("spot", { spot_target: 2 })]),
  ];
  expect(keys(deptStops(order, "spot", 1))).toEqual(["allspot", "spot1", "both"]);
  expect(keys(deptStops(order, "spot", 2))).toEqual(["allspot", "spot2", "both"]);
  // A stop addressing both spots yields exactly the cue for the asked spot.
  expect(deptCues(order[3], "spot", 1)).toHaveLength(1);
  expect(deptCues(order[3], "spot", 1)[0].spot_target).toBe(1);
  expect(deptCues(order[3], "spot", 2)[0].spot_target).toBe(2);
  // The ALL-spots cue is visible to every spot operator.
  expect(deptCues(order[0], "spot", 5)).toHaveLength(1);
  // computeArmed respects the spot filter + fired set: for spot 2, spot1 (idx1)
  // is not a stop, so from idx1 (past the fired allspot) armed advances to spot2.
  expect(computeArmed(order, "spot", 0, [], 2)).toBe(0); // allspot
  expect(computeArmed(order, "spot", 1, ["allspot"], 2)).toBe(2); // spot1 skipped → spot2
});

// ---------------------------------------------------------------------------
// applyRearm + nextOfType
// ---------------------------------------------------------------------------

test("applyRearm drops fired keys at/after a given index", () => {
  const order: OrderEntry[] = [
    lineEntry("a", [mkCue("lights")]),
    lineEntry("b", [mkCue("lights")]),
    lineEntry("c", [mkCue("lights")]),
  ];
  const state = mkState({
    depts: {
      lights: { firedKeys: ["a", "b", "c"], loopKey: null, loopStep: 0 },
      audio: { firedKeys: [], loopKey: null, loopStep: 0 },
    },
  });
  // Re-arm from index 1 (key b) → keep a, drop b & c.
  const s = applyRearm(order, state, "lights", 1);
  expect(s.depts.lights.firedKeys).toEqual(["a"]);
});

// ---------------------------------------------------------------------------
// resolvePosIdx + spot ACTIVE/STANDBY derivation (§5.3)
// ---------------------------------------------------------------------------

test("resolvePosIdx prefers the key, falls back to a clamped idx", () => {
  const order: OrderEntry[] = [lineEntry("a", []), lineEntry("b", []), lineEntry("c", [])];
  expect(resolvePosIdx(order, "b", 99)).toBe(1); // key wins over advisory idx
  expect(resolvePosIdx(order, "gone", 2)).toBe(2); // vanished key → clamp idx
  expect(resolvePosIdx(order, "gone", 99)).toBe(2); // clamp into range
  expect(resolvePosIdx([], "x", 3)).toBe(-1); // empty order
});

test("spotActive/spotStandby derive from position with spot_target filtering", () => {
  // idx: 0 allspot · 1 gap · 2 spot2 · 3 gap · 4 spot1+spot2 · 5 gap
  const order: OrderEntry[] = [
    lineEntry("allspot", [mkCue("spot", { spot_target: 0 })]),
    lineEntry("gap1", []),
    lineEntry("spot2", [mkCue("spot", { spot_target: 2 })]),
    lineEntry("gap2", []),
    lineEntry("both", [mkCue("spot", { spot_target: 1 }), mkCue("spot", { spot_target: 2 })]),
    lineEntry("gap3", []),
  ];
  // Spot 2 at position 3: ACTIVE = last spot-2 stop at/before → idx2; STANDBY idx4.
  expect(spotActive(order, 2, 3)).toBe(2);
  expect(spotStandby(order, 2, 3)).toBe(4);
  // Spot 1 at position 3: the spot-2-only stop (idx2) is invisible → ACTIVE = the
  // allspot at idx0; STANDBY = the "both" stop at idx4.
  expect(spotActive(order, 1, 3)).toBe(0);
  expect(spotStandby(order, 1, 3)).toBe(4);
  // Before any cue → no active.
  expect(spotActive(order, 2, 0)).toBe(0); // on the allspot
  expect(spotActive(order, 1, -1)).toBe(-1);
  // On the anchor exactly → ACTIVE includes it (at/before is inclusive).
  expect(spotActive(order, 2, 2)).toBe(2);
  expect(spotStandby(order, 2, 4)).toBe(-1); // nothing after the last stop
});

test("spotCueFor prefers a cue targeting this spot over an ALL-spots cue", () => {
  const both = lineEntry("both", [
    mkCue("spot", { spot_target: 0 }),
    mkCue("spot", { spot_target: 2 }),
  ]);
  expect(spotCueFor(both, 2)?.spot_target).toBe(2); // specific wins
  expect(spotCueFor(both, 1)?.spot_target).toBe(0); // only the ALL cue applies
  expect(spotCueFor(lineEntry("none", []), 1)).toBeUndefined();
});

test("nextOfType finds the next matching entry after `from`", () => {
  const order: OrderEntry[] = [
    lineEntry("a", []),
    lineEntry("b", [mkCue("lights")]),
    lineEntry("c", []),
    lineEntry("d", [mkCue("audio")]),
  ];
  const hasCue = (e: OrderEntry) => e.cues.length > 0;
  expect(nextOfType(order, -1, hasCue)).toBe(1);
  expect(nextOfType(order, 1, hasCue)).toBe(3);
  expect(nextOfType(order, 3, hasCue)).toBe(-1);
});
