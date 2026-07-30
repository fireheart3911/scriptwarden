// server/fire.ts — department-aware fire dispatch (§4.3, §6, §7).
//
// The single place that turns a stored cue into a fired-log entry, SHARED by the
// HTTP test-fire path (routes/osc.ts) and the WebSocket show path (ws/room.ts).
// Dispatch is by cue.department:
//   lights → OscService (configured per-production, per fire_mode)  → OscLogEntry
//   audio  → AvantisService (MIDI-over-TCP, stub-first)             → AvantisLogEntry
//   spot   → no hardware; a human-readable instruction line         → AvantisLogEntry-shaped

import { db } from "./db";
import { osc } from "./osc/OscService";
import { avantis } from "./midi/AvantisService";
import type { Cue } from "../src/types";
import type { AvantisLogEntry, FireLogEntry } from "../shared/protocol";

// The subset of a production row the fire path needs. Read via getFireProduction
// so the column list lives in exactly one place.
export interface FireProduction {
  osc_ip: string;
  osc_port: number;
  osc_protocol: string;
  osc_enabled: number;
  avantis_ip: string;
  avantis_port: number;
  avantis_channel: number;
  avantis_enabled: number;
}

export function getFireProduction(productionId: number): FireProduction | null {
  return (
    (db
      .query(
        `SELECT osc_ip, osc_port, osc_protocol, osc_enabled,
                avantis_ip, avantis_port, avantis_channel, avantis_enabled
         FROM productions WHERE id = ?`,
      )
      .get(productionId) as FireProduction | null) ?? null
  );
}

// Fire (or stub) a single cue against a production's console config.
export function fireCue(cue: Cue, production: FireProduction): FireLogEntry {
  switch (cue.department) {
    case "audio":
      return fireAudio(cue, production);
    case "spot":
      return fireSpot(cue);
    case "lights":
    default:
      return fireLights(cue, production);
  }
}

function fireLights(cue: Cue, production: FireProduction): FireLogEntry {
  osc.configure({
    ip: production.osc_ip,
    port: production.osc_port,
    protocol: production.osc_protocol === "tcp" ? "tcp" : "udp",
    enabled: !!production.osc_enabled,
  });
  return osc.fireCue(cue);
}

function fireAudio(cue: Cue, production: FireProduction): AvantisLogEntry {
  avantis.configure({
    ip: production.avantis_ip,
    port: production.avantis_port,
    baseChannel: production.avantis_channel,
    enabled: !!production.avantis_enabled,
  });
  // recallScene never throws — bad/unset scene numbers become a logged stub
  // entry, and transport failures are logged with sent:false.
  return avantis.recallScene(cue.avantis_scene);
}

function fireSpot(cue: Cue): AvantisLogEntry {
  const tgt = cue.spot_target ? `Spot ${cue.spot_target}` : "ALL";
  const details = [
    cue.spot_pickup && `pickup ${cue.spot_pickup}`,
    cue.spot_color && `color ${cue.spot_color}`,
    cue.spot_size && `size ${cue.spot_size}`,
  ]
    .filter(Boolean)
    .join(", ");
  // No hardware for spots (§5.3): the "fire" is the instruction shown on the
  // spot screen. hex:"" keeps it inside the AvantisLogEntry shape of the union.
  return { ts: new Date().toISOString(), hex: "", preview: `SPOT ${tgt}: ${details}`, sent: false };
}
