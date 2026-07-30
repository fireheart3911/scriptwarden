// server/routes/avantis.ts — Avantis (audio console) log + test-fire (§7).
//
// Mirrors routes/osc.ts: the log endpoints are LAN-open (read-only diagnostics),
// and test-fire is available to the crew for pre-show checks. The console
// CONFIG (ip/port/channel/enabled) is patched through /api/productions/:id,
// where it is admin-guarded.

import type { Hono } from "hono";
import { db } from "../db";
import { avantis } from "../midi/AvantisService";

interface ProductionAvantis {
  avantis_ip: string;
  avantis_port: number;
  avantis_channel: number;
  avantis_enabled: number;
}

function configureFromProduction(productionId: number): boolean {
  const p = db
    .query(
      "SELECT avantis_ip, avantis_port, avantis_channel, avantis_enabled FROM productions WHERE id = ?",
    )
    .get(productionId) as ProductionAvantis | null;
  if (!p) return false;
  avantis.configure({
    ip: p.avantis_ip,
    port: p.avantis_port,
    baseChannel: p.avantis_channel,
    enabled: !!p.avantis_enabled,
  });
  return true;
}

export function registerAvantis(app: Hono): void {
  app.get("/api/avantis/log", (c) => c.json({ config: avantis.getConfig(), log: avantis.getLog() }));
  app.delete("/api/avantis/log", (c) => {
    avantis.clearLog();
    return c.json({ ok: true });
  });

  // Test-recall a scene by number (pre-show hardware check / Settings panel).
  // Body: { scene }. Stub-logged unless live send is enabled.
  app.post("/api/productions/:id/avantis/test", async (c) => {
    const id = Number(c.req.param("id"));
    if (!configureFromProduction(id)) return c.json({ error: "production not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const scene = Math.trunc(Number(body?.scene) || 0);
    return c.json(avantis.recallScene(scene));
  });
}
