// scripts/test-ws.ts — M1 live-sync integration test (dev utility).
//
// Spawns a fresh server against a scratch DB on a scratch port, then drives
// 3 WebSocket clients through the M1 protocol and asserts the core guarantees:
//   join -> welcome snapshot; caller position broadcasts to others; non-caller
//   position rejected (error not_caller); grantCaller flips authority; seq
//   increments; sync returns state; kick closes with `kicked`; reconnect with
//   the same token gets a fresh welcome.
//
// Run:  PORT=3991 SCRIPTWARDEN_DB=/abs/scratch.db bun scripts/test-ws.ts
// Both env vars default to safe scratch values, so `bun scripts/test-ws.ts`
// works standalone.

import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import type { RoomState, S2C } from "../shared/protocol";
import { buildOrder } from "../shared/runningOrder";
import {
  computeArmed,
  isLoopStop,
  resolvePosIdx,
  spotActive,
  spotStandby,
} from "../shared/showSync";

const V2_ROOT = join(import.meta.dir, "..");
const PORT = process.env.PORT ?? "3991";
const BASE = `http://localhost:${PORT}`;
const DB = process.env.SCRIPTWARDEN_DB ?? join(import.meta.dir, `test-ws-${Date.now()}.db`);

let passed = 0;
function ok(cond: unknown, label: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  passed++;
  console.log(`  ok  ${label}`);
}

function cleanupDb(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = DB + suffix;
    if (existsSync(p)) {
      try {
        rmSync(p);
      } catch {
        /* ignore */
      }
    }
  }
}

// --- tiny WS client -------------------------------------------------------

class Client {
  private ws: WebSocket;
  readonly msgs: S2C[] = [];
  closed = false;
  closeCode = 0;
  private waiters: { pred: (m: S2C) => boolean; resolve: (m: S2C) => void; timer: Timer }[] = [];

  constructor(token: string) {
    this.ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${token}`);
    this.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as S2C;
      this.msgs.push(m);
      for (const w of [...this.waiters]) {
        if (w.pred(m)) {
          clearTimeout(w.timer);
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    };
    this.ws.onclose = (e) => {
      this.closed = true;
      this.closeCode = e.code;
    };
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("ws open timeout")), 4000);
      this.ws.onopen = () => {
        clearTimeout(t);
        resolve();
      };
      this.ws.addEventListener("error", () => {
        clearTimeout(t);
        reject(new Error("ws error"));
      });
    });
  }

  send(o: unknown): void {
    this.ws.send(JSON.stringify(o));
  }

  waitFor(pred: (m: S2C) => boolean, label: string, timeout = 3000): Promise<S2C> {
    const existing = this.msgs.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for: ${label}`)), timeout);
      this.waiters.push({ pred, resolve, timer });
    });
  }

  close(): void {
    this.ws.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function joinCrew(
  productionId: number,
  name: string,
  role: string,
  spot_no = 0,
): Promise<{ token: string; user: { id: number; name: string; is_admin: boolean } }> {
  const res = await fetch(`${BASE}/api/productions/${productionId}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, role, spot_no }),
  });
  if (!res.ok) throw new Error(`join ${name} failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{
    token: string;
    user: { id: number; name: string; is_admin: boolean };
  }>;
}

async function main(): Promise<void> {
  cleanupDb();
  console.log(`[test-ws] DB=${DB} PORT=${PORT}`);

  const proc = Bun.spawn([process.execPath, "server/index.ts"], {
    cwd: V2_ROOT,
    env: { ...process.env, PORT, SCRIPTWARDEN_DB: DB, NODE_ENV: "test" },
    stdout: "inherit",
    stderr: "inherit",
  });

  try {
    // Wait for the server to come up.
    let up = false;
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) {
          up = true;
          break;
        }
      } catch {
        /* not ready */
      }
      await sleep(200);
    }
    if (!up) throw new Error("server did not become ready");

    // --- seed a production with a 3-line script ---------------------------
    const prodRes = await fetch(`${BASE}/api/productions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "WS Test Show" }),
    });
    const production = (await prodRes.json()) as { id: number };
    const pid = production.id;

    const scriptRes = await fetch(`${BASE}/api/productions/${pid}/script`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lines: [
          { type: "dialogue", speaker: "A", text: "one" },
          { type: "dialogue", speaker: "B", text: "two" },
          { type: "dialogue", speaker: "C", text: "three" },
        ],
      }),
    });
    const { lines } = (await scriptRes.json()) as { lines: { id: number }[] };
    const keys = lines.map((l) => `line-${l.id}`);
    ok(keys.length === 3, "seeded 3-line script");

    // --- net-info ---------------------------------------------------------
    const netInfo = (await fetch(`${BASE}/api/net-info`).then((r) => r.json())) as {
      port: number;
      ips: string[];
    };
    ok(netInfo.port === Number(PORT), "net-info returns the port");

    // --- join 3 crew ------------------------------------------------------
    const A = await joinCrew(pid, "Alice", "caller"); // claims caller (vacant)
    const B = await joinCrew(pid, "Bob", "lights");
    const C = await joinCrew(pid, "Cara", "spot", 1);
    ok(A.user.is_admin, "loopback join is admin (Alice)");

    // --- wrong PIN (set a join_pin, then a mismatching join) --------------
    await fetch(`${BASE}/api/productions/${pid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ join_pin: "1234" }),
    });
    const badPin = await fetch(`${BASE}/api/productions/${pid}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Non-loopback would be blocked; from loopback the admin-by-ip still needs
      // the pin unless it equals the admin pin, so send a wrong pin as a
      // non-admin would. We assert the 403 shape via a fresh name + wrong pin.
      body: JSON.stringify({ name: "Nope", role: "viewer", pin: "0000" }),
    });
    // From loopback the joiner is admin-by-ip, which does NOT bypass join_pin
    // (only the admin PIN does). So a wrong pin is rejected.
    ok(badPin.status === 403, "wrong PIN -> 403 bad_pin");
    // reset the pin so it doesn't interfere with later reconnect joins
    await fetch(`${BASE}/api/productions/${pid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ join_pin: "" }),
    });

    // --- connect all three WS --------------------------------------------
    const ca = new Client(A.token);
    const cb = new Client(B.token);
    const cc = new Client(C.token);
    await Promise.all([ca.open(), cb.open(), cc.open()]);

    const wa = (await ca.waitFor((m) => m.type === "welcome", "A welcome")) as Extract<
      S2C,
      { type: "welcome" }
    >;
    await cb.waitFor((m) => m.type === "welcome", "B welcome");
    await cc.waitFor((m) => m.type === "welcome", "C welcome");
    ok(wa.you.name === "Alice", "welcome.you identifies the socket");
    ok(wa.state.callerUserId === A.user.id, "caller claimed at join (Alice)");
    ok(
      Array.isArray(wa.roster) && wa.roster.length === 3,
      "welcome.roster lists all 3 crew",
    );
    const startSeq = wa.state.seq;

    // --- caller position broadcasts to others ----------------------------
    ca.send({ type: "position", key: keys[1], idx: 1 });
    const pbOnB = (await cb.waitFor(
      (m) => m.type === "position" && m.key === keys[1],
      "B receives caller position",
    )) as Extract<S2C, { type: "position" }>;
    ok(pbOnB.key === keys[1] && pbOnB.idx === 1, "position carries resolved key+idx");
    ok(pbOnB.seq === startSeq + 1, "seq increments on position (+1)");

    // second move -> seq increments again
    ca.send({ type: "position", key: keys[2], idx: 2 });
    const pb2 = (await cb.waitFor(
      (m) => m.type === "position" && m.key === keys[2],
      "B receives second caller position",
    )) as Extract<S2C, { type: "position" }>;
    ok(pb2.seq === startSeq + 2, "seq increments on position (+2)");

    // --- non-caller position rejected ------------------------------------
    cb.send({ type: "position", key: keys[0], idx: 0 });
    const errB = (await cb.waitFor(
      (m) => m.type === "error",
      "B gets error for non-caller position",
    )) as Extract<S2C, { type: "error" }>;
    ok(errB.code === "not_caller", "non-caller position -> error not_caller");

    // --- sync returns full state -----------------------------------------
    cc.send({ type: "sync" });
    const st = (await cc.waitFor((m) => m.type === "state", "C sync -> state")) as Extract<
      S2C,
      { type: "state" }
    >;
    ok(st.state.position.key === keys[2], "sync state reflects latest position");
    ok(st.state.seq === startSeq + 2, "sync state carries current seq");

    // --- timer ------------------------------------------------------------
    ca.send({ type: "showStart" });
    const timerOn = (await cb.waitFor(
      (m) => m.type === "timer" && m.startedAt !== null,
      "B sees timer start",
    )) as Extract<S2C, { type: "timer" }>;
    ok(typeof timerOn.startedAt === "string", "showStart broadcasts a timer epoch");

    // --- grantCaller flips authority -------------------------------------
    // Alice (admin) grants caller to Bob.
    ca.send({ type: "grantCaller", userId: B.user.id });
    const cc1 = (await cb.waitFor(
      (m) => m.type === "callerChanged" && m.userId === B.user.id,
      "callerChanged -> Bob",
    )) as Extract<S2C, { type: "callerChanged" }>;
    ok(cc1.userId === B.user.id, "grantCaller broadcasts callerChanged to Bob");

    // Now Bob can move position...
    cb.send({ type: "position", key: keys[0], idx: 0 });
    const pbOnA = (await ca.waitFor(
      (m) => m.type === "position" && m.key === keys[0],
      "A receives Bob's caller position",
    )) as Extract<S2C, { type: "position" }>;
    ok(pbOnA.key === keys[0], "new caller (Bob) drives the position");

    // ...and Alice (old caller) is now rejected.
    ca.send({ type: "position", key: keys[2], idx: 2 });
    const errA = (await ca.waitFor(
      (m) => m.type === "error",
      "A rejected after losing caller",
    )) as Extract<S2C, { type: "error" }>;
    ok(errA.code === "not_caller", "old caller (Alice) position -> error not_caller");

    // --- kick closes with `kicked` ---------------------------------------
    const kickRes = await fetch(`${BASE}/api/admin/kick`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Token": A.token },
      body: JSON.stringify({ userId: C.user.id }),
    });
    ok(kickRes.ok, "admin kick returns ok");
    await cc.waitFor((m) => m.type === "kicked", "C receives kicked frame");
    await sleep(300);
    ok(cc.closed, "C socket closed after kick");

    // kicked token is refused on reconnect
    const refused = new Client(C.token);
    await sleep(400);
    ok(refused.closed && refused.closeCode === 4001, "revoked token refused (4001)");

    // --- reconnect with same token gets welcome --------------------------
    const ca2 = new Client(A.token);
    await ca2.open();
    const wa2 = (await ca2.waitFor(
      (m) => m.type === "welcome",
      "A reconnect welcome",
    )) as Extract<S2C, { type: "welcome" }>;
    ok(wa2.you.id === A.user.id, "reconnect with same token -> same identity");
    ok(wa2.state.position.key === keys[0], "reconnect resumes latest position");

    // =====================================================================
    // M2 — department cues + server-authoritative firing
    // =====================================================================
    console.log("\n[test-ws] --- M2 department firing ---");

    // Fresh production so the M2 walk doesn't disturb the M1 state above.
    const pid2 = (
      (await fetch(`${BASE}/api/productions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "M2 Dept Show" }),
      }).then((r) => r.json())) as { id: number }
    ).id;

    // Seed: top / lights1 / audio1 / lights2 / SONG(loop) / after.
    const sLines = (
      (await fetch(`${BASE}/api/productions/${pid2}/script`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: [
            { type: "dialogue", text: "top" },
            { type: "dialogue", text: "lights1" },
            { type: "dialogue", text: "audio1" },
            { type: "dialogue", text: "lights2" },
            { type: "song", text: "SONG" },
            { type: "dialogue", text: "after" },
          ],
        }),
      }).then((r) => r.json())) as { lines: { id: number }[] }
    ).lines;

    const addCue = async (body: Record<string, unknown>): Promise<{ id: number }> => {
      const r = await fetch(`${BASE}/api/productions/${pid2}/cues`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`addCue failed: ${r.status}`);
      return r.json() as Promise<{ id: number }>;
    };

    await addCue({ anchor_type: "line", anchor_id: sLines[1].id, department: "lights", fire_mode: "fire", cue_list: 1, cue_number: "1" });
    await addCue({ anchor_type: "line", anchor_id: sLines[2].id, department: "audio", avantis_scene: 96, cue_number: "A" });
    await addCue({ anchor_type: "line", anchor_id: sLines[3].id, department: "lights", fire_mode: "fire", cue_list: 1, cue_number: "2" });
    const section = (await fetch(`${BASE}/api/lines/${sLines[4].id}/sections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "LOOP", loop: true }),
    }).then((r) => r.json())) as { id: number };
    await addCue({ anchor_type: "section", anchor_id: section.id, department: "lights", fire_mode: "fire", cue_list: 1, cue_number: "1" });
    await addCue({ anchor_type: "section", anchor_id: section.id, department: "lights", fire_mode: "fire", cue_list: 1, cue_number: "2" });
    await addCue({ anchor_type: "line", anchor_id: sLines[5].id, department: "lights", fire_mode: "fire", cue_list: 1, cue_number: "3" });
    // Spot cues for the SpotView derivation check: an ALL-spots cue on `top`
    // (idx0) and a Spot-2 cue on `after` (idx6). Attaching to existing lines keeps
    // the 7-stop order intact.
    await addCue({ anchor_type: "line", anchor_id: sLines[0].id, department: "spot", spot_target: 0, spot_pickup: "Narrator", spot_color: "OW", spot_size: "full" });
    await addCue({ anchor_type: "line", anchor_id: sLines[5].id, department: "spot", spot_target: 2, spot_pickup: "Hamlet", spot_color: "CTB", spot_size: "tight" });

    // Build the order the way the server/client do, to derive expected keys.
    const bundle2 = (await fetch(`${BASE}/api/productions/${pid2}/bundle`).then((r) => r.json())) as {
      lines: never[];
      sections: never[];
      cues: never[];
    };
    const order = buildOrder(bundle2.lines, bundle2.sections, bundle2.cues);
    ok(order.length === 7, "M2 seed builds a 7-stop order");
    ok(isLoopStop(order[5]), "the loop section sits at order index 5");
    const L1 = order[1].key;
    const L2 = order[3].key;
    const LOOP = order[5].key;
    const L3 = order[6].key;
    const armedLights = (fired: string[], posIdx = 0): string => {
      const i = computeArmed(order, "lights", posIdx, fired);
      return i >= 0 ? order[i].key : "";
    };

    // Crew: caller (admin by loopback) + non-admin lights/audio operators + a
    // spot-2 bot (input-less; derives its cards from the shared position).
    const CALLER = await joinCrew(pid2, "M2Caller", "caller");
    const LIGHTS = await joinCrew(pid2, "M2Lights", "lights");
    const AUDIO = await joinCrew(pid2, "M2Audio", "audio");
    const SPOT2 = await joinCrew(pid2, "M2Spot2", "spot", 2);
    // Loopback joins are admin, and admin bypasses the dept role gate. Demote the
    // operators directly in the DB so the role gate is actually exercised.
    const tdb = new Database(DB);
    tdb.exec("PRAGMA busy_timeout = 5000;");
    tdb.query("UPDATE users SET is_admin = 0 WHERE id IN (?, ?)").run(LIGHTS.user.id, AUDIO.user.id);
    tdb.close();

    const callerWs = new Client(CALLER.token);
    const lightsWs = new Client(LIGHTS.token);
    const audioWs = new Client(AUDIO.token);
    const spotWs = new Client(SPOT2.token);
    await Promise.all([callerWs.open(), lightsWs.open(), audioWs.open(), spotWs.open()]);
    const w2 = (await callerWs.waitFor((m) => m.type === "welcome", "M2 caller welcome")) as Extract<
      S2C,
      { type: "welcome" }
    >;
    await lightsWs.waitFor((m) => m.type === "welcome", "M2 lights welcome");
    await audioWs.waitFor((m) => m.type === "welcome", "M2 audio welcome");
    await spotWs.waitFor((m) => m.type === "welcome", "M2 spot welcome");
    ok(w2.state.callerUserId === CALLER.user.id, "M2 caller claimed at join");

    // Seq-ordered consumers (position/fired/rearmed carry a monotonic seq).
    let seqCursor = w2.state.seq;
    const waitSeq = async (
      client: Client,
      pred: (m: S2C) => boolean,
      label: string,
    ): Promise<S2C> => {
      const m = await client.waitFor(
        (mm) => typeof (mm as { seq?: number }).seq === "number" && (mm as { seq: number }).seq > seqCursor && pred(mm),
        label,
      );
      seqCursor = (m as { seq: number }).seq;
      return m;
    };
    // reset broadcasts a full `state` (state.seq monotonic, no top-level seq).
    const waitResetState = async (client: Client): Promise<Extract<S2C, { type: "state" }>> => {
      const m = (await client.waitFor(
        (mm) => mm.type === "state" && (mm as Extract<S2C, { type: "state" }>).state.seq > seqCursor,
        "reset state",
      )) as Extract<S2C, { type: "state" }>;
      seqCursor = m.state.seq;
      return m;
    };
    // Snapshot the live RoomState via a throwaway socket's welcome (dodges the
    // per-client message-history reuse that plagues repeated `state` waits).
    const snapshotState = async (token: string): Promise<RoomState> => {
      const probe = new Client(token);
      await probe.open();
      const w = (await probe.waitFor((m) => m.type === "welcome", "probe welcome")) as Extract<
        S2C,
        { type: "welcome" }
      >;
      probe.close();
      return w.state;
    };
    const patchSettings = (settings: Record<string, unknown>) =>
      fetch(`${BASE}/api/productions/${pid2}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: JSON.stringify(settings) }),
      });

    // --- lights GO fires + broadcast reaches a second client ---------------
    lightsWs.send({ type: "go", dept: "lights", expectedKey: L1 });
    const fired1 = (await waitSeq(
      audioWs,
      (m) => m.type === "fired" && (m as Extract<S2C, { type: "fired" }>).stopKey === L1,
      "audio client receives lights GO L1",
    )) as Extract<S2C, { type: "fired" }>;
    ok(fired1.dept === "lights" && fired1.stopKey === L1, "fired broadcast reaches a second client");
    ok(fired1.entries.length === 1 && fired1.entries[0].sent === false, "L1 → one stubbed OSC entry");
    ok(fired1.byUserId === LIGHTS.user.id, "fired is tagged with the firing operator");
    ok(
      lightsWs.msgs.some((m) => m.type === "fired" && (m as Extract<S2C, { type: "fired" }>).stopKey === L1),
      "the firing client also receives the fired broadcast",
    );

    // --- wrong-role GO rejected -------------------------------------------
    audioWs.send({ type: "go", dept: "lights", expectedKey: L2 });
    const err2 = (await audioWs.waitFor(
      (m) => m.type === "error" && (m as Extract<S2C, { type: "error" }>).code === "bad_dept",
      "audio operator firing lights → bad_dept",
    )) as Extract<S2C, { type: "error" }>;
    ok(err2.code === "bad_dept", "wrong-role GO → error bad_dept");

    // --- stale expectedKey → error{stale} + state snapshot ----------------
    lightsWs.send({ type: "go", dept: "lights", expectedKey: L1 }); // L1 already fired → armed is L2
    const err3 = (await lightsWs.waitFor(
      (m) => m.type === "error" && (m as Extract<S2C, { type: "error" }>).code === "stale",
      "stale GO → error stale",
    )) as Extract<S2C, { type: "error" }>;
    ok(err3.code === "stale", "stale expectedKey → error stale");
    const snap3 = (await lightsWs.waitFor((m) => m.type === "state", "stale GO returns a snapshot")) as Extract<
      S2C,
      { type: "state" }
    >;
    ok(snap3.state.depts.lights.firedKeys.includes(L1), "stale snapshot carries the real fired-set");

    // --- loop cycling ------------------------------------------------------
    lightsWs.send({ type: "go", dept: "lights", expectedKey: L2 });
    await waitSeq(lightsWs, (m) => m.type === "fired" && (m as Extract<S2C, { type: "fired" }>).stopKey === L2, "GO L2");
    ok(armedLights([L1, L2]) === LOOP, "after L1/L2 the armed lights stop is the loop");
    lightsWs.send({ type: "go", dept: "lights", expectedKey: LOOP });
    const loopA = (await waitSeq(
      lightsWs,
      (m) => m.type === "fired" && (m as Extract<S2C, { type: "fired" }>).stopKey === LOOP,
      "loop GO #1",
    )) as Extract<S2C, { type: "fired" }>;
    ok(loopA.entries.length === 1 && loopA.loopStep === 1, "loop GO fires ONE cue, loopStep → 1");
    const cueA = loopA.entries[0].preview;
    lightsWs.send({ type: "go", dept: "lights", expectedKey: LOOP });
    const loopB = (await waitSeq(
      lightsWs,
      (m) => m.type === "fired" && (m as Extract<S2C, { type: "fired" }>).loopStep === 2,
      "loop GO #2",
    )) as Extract<S2C, { type: "fired" }>;
    ok(loopB.loopStep === 2 && loopB.entries[0].preview !== cueA, "loop GO #2 cycles to the other cue");
    lightsWs.send({ type: "go", dept: "lights", expectedKey: LOOP });
    const loopA2 = (await waitSeq(
      lightsWs,
      (m) => m.type === "fired" && (m as Extract<S2C, { type: "fired" }>).loopStep === 3,
      "loop GO #3",
    )) as Extract<S2C, { type: "fired" }>;
    ok(loopA2.entries[0].preview === cueA, "loop GO #3 wraps back to the first cue");

    // --- exitLoop advances the armed pointer -------------------------------
    lightsWs.send({ type: "exitLoop", dept: "lights", expectedKey: LOOP });
    const rearmed5 = (await waitSeq(
      lightsWs,
      (m) => m.type === "rearmed" && (m as Extract<S2C, { type: "rearmed" }>).dept === "lights",
      "exitLoop → rearmed",
    )) as Extract<S2C, { type: "rearmed" }>;
    ok(rearmed5.firedKeys.includes(LOOP), "exitLoop marks the loop stop fired");
    ok(armedLights([L1, L2, LOOP]) === L3, "armed advances past the loop to L3");
    lightsWs.send({ type: "go", dept: "lights", expectedKey: L3 });
    const firedL3 = (await waitSeq(
      lightsWs,
      (m) => m.type === "fired" && (m as Extract<S2C, { type: "fired" }>).stopKey === L3,
      "GO L3 after exitLoop",
    )) as Extract<S2C, { type: "fired" }>;
    ok(firedL3.stopKey === L3, "L3 fires after the loop is exited");

    // --- rearm restores an earlier fired-set -------------------------------
    lightsWs.send({ type: "rearm", dept: "lights", fromKey: L2 });
    const rearmed6 = (await waitSeq(
      lightsWs,
      (m) => m.type === "rearmed" && (m as Extract<S2C, { type: "rearmed" }>).dept === "lights",
      "rearm from L2",
    )) as Extract<S2C, { type: "rearmed" }>;
    ok(rearmed6.firedKeys.length === 1 && rearmed6.firedKeys[0] === L1, "rearm from L2 keeps only L1");
    ok(armedLights([L1]) === L2, "armed is restored to L2 after rearm");

    // --- rewindRearm ON / OFF on a caller rewind ---------------------------
    // Reset to a clean slate; rewindRearm defaults ON (the one default-on setting).
    callerWs.send({ type: "reset" });
    await waitResetState(callerWs);
    await patchSettings({ goGuard: 0, rewindRearm: true });
    lightsWs.send({ type: "go", dept: "lights", expectedKey: L1 });
    await waitSeq(lightsWs, (m) => m.type === "fired" && (m as Extract<S2C, { type: "fired" }>).stopKey === L1, "rewind-ON: fire L1");
    lightsWs.send({ type: "go", dept: "lights", expectedKey: L2 });
    await waitSeq(lightsWs, (m) => m.type === "fired" && (m as Extract<S2C, { type: "fired" }>).stopKey === L2, "rewind-ON: fire L2");
    callerWs.send({ type: "position", key: L2, idx: 3 });
    await waitSeq(callerWs, (m) => m.type === "position" && (m as Extract<S2C, { type: "position" }>).idx === 3, "rewind-ON: caller forward to idx3");
    callerWs.send({ type: "position", key: L1, idx: 1 });
    const rewOn = (await waitSeq(
      callerWs,
      (m) => m.type === "position" && (m as Extract<S2C, { type: "position" }>).idx === 1,
      "rewind-ON: caller rewind to idx1",
    )) as Extract<S2C, { type: "position" }>;
    ok(rewOn.clearedFired?.includes("lights") === true, "rewind with rewindRearm ON reports clearedFired: lights");
    ok((await snapshotState(AUDIO.token)).depts.lights.firedKeys.length === 0, "rewind ON actually clears the fired-set");

    // Now OFF: the same rewind must NOT clear.
    await patchSettings({ goGuard: 0, rewindRearm: false });
    callerWs.send({ type: "position", key: order[0].key, idx: 0 });
    await waitSeq(callerWs, (m) => m.type === "position" && (m as Extract<S2C, { type: "position" }>).idx === 0, "rewind-OFF: caller to top");
    lightsWs.send({ type: "go", dept: "lights", expectedKey: L1 });
    await waitSeq(lightsWs, (m) => m.type === "fired" && (m as Extract<S2C, { type: "fired" }>).stopKey === L1, "rewind-OFF: fire L1");
    lightsWs.send({ type: "go", dept: "lights", expectedKey: L2 });
    await waitSeq(lightsWs, (m) => m.type === "fired" && (m as Extract<S2C, { type: "fired" }>).stopKey === L2, "rewind-OFF: fire L2");
    callerWs.send({ type: "position", key: L2, idx: 3 });
    await waitSeq(callerWs, (m) => m.type === "position" && (m as Extract<S2C, { type: "position" }>).idx === 3, "rewind-OFF: caller forward to idx3");
    callerWs.send({ type: "position", key: L1, idx: 1 });
    const rewOff = (await waitSeq(
      callerWs,
      (m) => m.type === "position" && (m as Extract<S2C, { type: "position" }>).idx === 1,
      "rewind-OFF: caller rewind to idx1",
    )) as Extract<S2C, { type: "position" }>;
    ok(rewOff.clearedFired === undefined, "rewind with rewindRearm OFF reports no clearedFired");
    ok((await snapshotState(AUDIO.token)).depts.lights.firedKeys.length === 2, "rewind OFF leaves the fired-set intact");

    // --- goGuard block + force override ------------------------------------
    callerWs.send({ type: "reset" });
    await waitResetState(callerWs);
    await patchSettings({ goGuard: 2, rewindRearm: true });
    lightsWs.send({ type: "go", dept: "lights", expectedKey: L1 }); // 1 ahead → within guard
    await waitSeq(lightsWs, (m) => m.type === "fired" && (m as Extract<S2C, { type: "fired" }>).stopKey === L1, "guard: near GO fires");
    lightsWs.send({ type: "go", dept: "lights", expectedKey: L2 }); // 3 ahead → blocked
    const guarded = (await lightsWs.waitFor(
      (m) => m.type === "error" && (m as Extract<S2C, { type: "error" }>).code === "guarded",
      "far GO → error guarded",
    )) as Extract<S2C, { type: "error" }>;
    ok(guarded.code === "guarded", "GO beyond goGuard distance is blocked");
    lightsWs.send({ type: "go", dept: "lights", expectedKey: L2, force: true });
    const forced = (await waitSeq(
      lightsWs,
      (m) => m.type === "fired" && (m as Extract<S2C, { type: "fired" }>).stopKey === L2,
      "force GO overrides the guard",
    )) as Extract<S2C, { type: "fired" }>;
    ok(forced.stopKey === L2, "force overrides the goGuard and fires");

    // --- audio armed independence + spot-view derivation -------------------
    // Clean slate so lights L1 is armable again and the fired-sets are empty.
    callerWs.send({ type: "reset" });
    await waitResetState(callerWs);

    // A spot-2 bot derives its ACTIVE/STANDBY purely from the shared position via
    // shared/showSync — no fired state. At the top, ACTIVE = the all-spots cue on
    // `top` (idx0), STANDBY = the Spot-2 cue ahead on `after` (idx6).
    {
      const st = await snapshotState(SPOT2.token);
      const p0 = resolvePosIdx(order, st.position.key, st.position.idx);
      ok(spotActive(order, 2, p0) === 0, "spot2 ACTIVE derives to the top all-spots cue at reset");
      ok(spotStandby(order, 2, p0) === 6, "spot2 STANDBY derives to the Spot-2 cue ahead");
    }

    // Firing a lights cue must NOT disturb audio's independent armed pointer.
    lightsWs.send({ type: "go", dept: "lights", expectedKey: L1 });
    await waitSeq(
      lightsWs,
      (m) => m.type === "fired" && (m as Extract<S2C, { type: "fired" }>).stopKey === L1,
      "independence: lights L1 fires",
    );
    {
      const st = await snapshotState(AUDIO.token);
      ok(st.depts.audio.firedKeys.length === 0, "audio fired-set untouched by a lights GO");
      ok(
        computeArmed(order, "audio", 0, st.depts.audio.firedKeys) === 2,
        "audio stays armed on its own stop while lights advances",
      );
    }

    // Caller crosses the Spot-2 anchor (idx6): the spot bot's derived ACTIVE flips
    // from the top all-spots cue to the Spot-2 cue, and STANDBY empties.
    callerWs.send({ type: "position", key: L3, idx: 6 });
    const spPos = (await spotWs.waitFor(
      (m) => m.type === "position" && (m as Extract<S2C, { type: "position" }>).idx === 6,
      "spot bot receives the caller position at the anchor",
    )) as Extract<S2C, { type: "position" }>;
    {
      const p = resolvePosIdx(order, spPos.key, spPos.idx);
      ok(spotActive(order, 2, p) === 6, "spot2 ACTIVE flips to the Spot-2 cue when the caller crosses it");
      ok(spotStandby(order, 2, p) === -1, "spot2 STANDBY empties past the last spot cue");
    }

    callerWs.close();
    lightsWs.close();
    audioWs.close();
    spotWs.close();

    ca.close();
    cb.close();
    ca2.close();

    console.log(`\n[test-ws] ALL PASSED (${passed} assertions)`);
  } finally {
    proc.kill();
    await proc.exited.catch(() => {});
    cleanupDb();
  }
}

main().catch((e) => {
  console.error(`\n[test-ws] FAILED: ${e?.message ?? e}`);
  process.exit(1);
});
