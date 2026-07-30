// shared/avantisEncode.ts — Allen & Heath Avantis scene recall over MIDI (§7).
//
// Pure, dependency-free, imported by BOTH the Bun server (fire path) and the
// Vite client (cue preview). Given a scene number (1..500) and a base MIDI
// channel (1..16), produce the 5 status bytes of a Bank Select MSB=0 +
// Bank Select LSB + Program Change sequence that recalls the scene:
//
//   n    = scene - 1            (Avantis scenes are 1-based; MIDI is 0-based)
//   bank = n >> 7              (LSB bank: scenes 1..128 -> 0, 129..256 -> 1, ...)
//   prog = n & 0x7F            (program number within the bank)
//   ch   = baseChannel - 1     (0-based MIDI channel)
//   bytes = [0xB0|ch, 0x00, bank, 0xC0|ch, prog]
//            └Bank MSB=0┘  └LSB┘  └ Program Change ┘
//
// Spec-verified against the Avantis MIDI protocol:
//   scene  96, ch 1 -> B0 00 00 C0 5F
//   scene 264, ch 1 -> B0 00 02 C0 07

export interface AvantisMidi {
  bytes: number[]; // 5 raw MIDI status/data bytes, ready to write to the socket
  hex: string; // uppercase space-separated preview, e.g. "B0 00 02 C0 07"
}

export function sceneToMidi(scene: number, baseChannel: number): AvantisMidi {
  if (!Number.isInteger(scene) || scene < 1 || scene > 500) {
    throw new RangeError(`avantis scene must be an integer 1..500 (got ${scene})`);
  }
  if (!Number.isInteger(baseChannel) || baseChannel < 1 || baseChannel > 16) {
    throw new RangeError(`avantis base channel must be an integer 1..16 (got ${baseChannel})`);
  }
  const n = scene - 1;
  const bank = n >> 7;
  const prog = n & 0x7f;
  const ch = baseChannel - 1;
  const bytes = [0xb0 | ch, 0x00, bank, 0xc0 | ch, prog];
  return { bytes, hex: toHex(bytes) };
}

// Uppercase two-digit hex, space separated — the on-screen / log preview form.
export function toHex(bytes: number[]): string {
  return bytes.map((b) => (b & 0xff).toString(16).toUpperCase().padStart(2, "0")).join(" ");
}
