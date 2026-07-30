// server/eosSync.ts — glue between a production's console config, the Eos TCP
// monitor and the WS hub. Called wherever the config may have changed or a
// watcher appears (join, production patch, eos/active fetch): reads the
// current osc_ip/osc_enabled and (re)configures the monitor; cue changes are
// broadcast to the production's room as seq-less `eosCue` frames.

import { db } from "./db";
import { hub } from "./ws/hub";
import { eosMonitors } from "./osc/EosMonitor";

export function syncEosMonitor(productionId: number): void {
  const p = db
    .query("SELECT osc_ip, osc_enabled FROM productions WHERE id = ?")
    .get(productionId) as { osc_ip: string; osc_enabled: number } | null;
  if (!p) return;
  eosMonitors.sync(productionId, p.osc_ip, !!p.osc_enabled, (s) =>
    hub.broadcast(productionId, { type: "eosCue", cue: s.cue, connected: s.connected }),
  );
}
