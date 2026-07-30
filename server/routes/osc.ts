import type { Hono } from "hono";
import { db } from "../db";
import { osc } from "../osc/OscService";
import { eosMonitors } from "../osc/EosMonitor";
import { syncEosMonitor } from "../eosSync";
import type { Cue } from "../../src/types";
import { fireCue, getFireProduction } from "../fire";
import { hub } from "../ws/hub";

interface ProductionOsc {
  osc_ip: string;
  osc_port: number;
  osc_protocol: "udp" | "tcp";
  osc_enabled: number;
}

// Point the singleton at a production's console settings before firing (used by
// the raw GO / cmd helpers below; department-aware cue firing goes through the
// shared fireCue() dispatch in server/fire.ts).
function configureFromProduction(productionId: number): boolean {
  const p = db
    .query("SELECT osc_ip, osc_port, osc_protocol, osc_enabled FROM productions WHERE id = ?")
    .get(productionId) as ProductionOsc | null;
  if (!p) return false;
  osc.configure({
    ip: p.osc_ip,
    port: p.osc_port,
    protocol: p.osc_protocol === "tcp" ? "tcp" : "udp",
    enabled: !!p.osc_enabled,
  });
  return true;
}

export function registerOsc(app: Hono): void {
  // The console's live active cue as mirrored by the Eos TCP monitor (§ read-
  // only; the fire path is untouched). Ensures the monitor is running for this
  // production's current config before answering.
  app.get("/api/productions/:id/eos/active", (c) => {
    const id = Number(c.req.param("id"));
    syncEosMonitor(id);
    return c.json(eosMonitors.status(id));
  });

  app.get("/api/osc/log", (c) => c.json({ config: osc.getConfig(), log: osc.getLog() }));
  app.delete("/api/osc/log", (c) => {
    osc.clearLog();
    return c.json({ ok: true });
  });

  // Test-fire a stored cue (pre-show hardware check). Dispatches by department
  // via the shared helper: lights → OSC, audio → Avantis hex (stub), spot →
  // instruction line. Returns the fire-log entry to the tester.
  app.post("/api/cues/:id/fire", (c) => {
    const cueId = Number(c.req.param("id"));
    const cue = db.query("SELECT * FROM cues WHERE id = ?").get(cueId) as Cue | null;
    if (!cue) return c.json({ error: "cue not found" }, 404);
    const production = getFireProduction(cue.production_id);
    if (!production) return c.json({ error: "production not found" }, 404);
    const entry = fireCue(cue, production);
    // Spot cues have no hardware — the "fire" is the instruction on the spot
    // screen. Broadcast a seq-less flash so a connected SpotView pulses (§6
    // pre-show check). This is separate from the position/fired seq machine.
    if (cue.department === "spot") {
      hub.broadcast(cue.production_id, {
        type: "spotFlash",
        target: cue.spot_target,
        preview: entry.preview,
        cueId: cue.id,
      });
    }
    return c.json(entry);
  });

  // Generic GO. Body: { productionId }.
  app.post("/api/productions/:id/go", (c) => {
    configureFromProduction(Number(c.req.param("id")));
    return c.json(osc.go());
  });

  // Raw command line. Body: { text }.
  app.post("/api/productions/:id/cmd", async (c) => {
    configureFromProduction(Number(c.req.param("id")));
    const body = await c.req.json().catch(() => ({}));
    return c.json(osc.sendCommand(String(body?.text ?? "")));
  });
}
