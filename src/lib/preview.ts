import type { Cue, Production } from "../types";
import { sceneToMidi } from "../../shared/avantisEncode";

// Department-aware cue preview (§6): shows EXACTLY what a cue will send before
// anything is transmitted. Shared by the CueEditor banner, the Cue Sheet, and
// ShowMode's standby/chip previews.
//   lights → the Eos OSC address (mirrors OscService.buildCueMessage)
//   audio  → the Avantis scene as MIDI hex + its target (mirrors shared/avantisEncode)
//   spot   → the human-readable spot instruction (mirrors server/fire.ts fireSpot)
//
// `production` is optional: it is only needed for the audio branch (base MIDI
// channel + target host). Callers that lack it (or the console isn't configured)
// get channel 1 and an "unconfigured" target — the hex still computes so the
// preview is useful in the editor before the desk is set up.
export function buildCuePreview(cue: Cue, production?: Production): string {
  switch (cue.department) {
    case "audio":
      return buildAudioPreview(cue, production);
    case "spot":
      return buildSpotPreview(cue);
    case "lights":
    default:
      return buildLightsPreview(cue);
  }
}

function buildLightsPreview(cue: Cue): string {
  switch (cue.fire_mode) {
    case "go":
      return "/eos/key/go_0";
    case "cmd":
      return `/eos/cmd ${cue.cmd_text}`.trim();
    case "fire":
    default:
      return `/eos/cue/${cue.cue_list}/${cue.cue_number || "?"}/fire`;
  }
}

// e.g. "Scene 264 → B0 00 02 C0 07 @ 10.0.0.5:51325"
function buildAudioPreview(cue: Cue, production?: Production): string {
  const ip = production?.avantis_ip || "unconfigured";
  const port = production?.avantis_port || 51325;
  let hex = "—";
  try {
    hex = sceneToMidi(cue.avantis_scene, baseChannelOf(production)).hex;
  } catch {
    // invalid/unset scene (0 or out of 1..500) — leave the hex placeholder.
  }
  return `Scene ${cue.avantis_scene || "?"} → ${hex} @ ${ip}:${port}`;
}

// The instruction card text (§5.3). e.g. "All spots · pick up Hamlet · CTB · tight"
function buildSpotPreview(cue: Cue): string {
  const target = cue.spot_target ? `Spot ${cue.spot_target}` : "All spots";
  const parts = [
    cue.spot_pickup && `pick up ${cue.spot_pickup}`,
    cue.spot_color && cue.spot_color,
    cue.spot_size && cue.spot_size,
  ].filter(Boolean);
  return parts.length ? `${target} · ${parts.join(" · ")}` : target;
}

// Base MIDI channel clamped to the valid 1..16 range, defaulting to 1 when the
// production is absent or misconfigured (so sceneToMidi never throws on channel).
function baseChannelOf(production?: Production): number {
  const ch = Math.trunc(Number(production?.avantis_channel));
  return ch >= 1 && ch <= 16 ? ch : 1;
}
