// shared/avantisEncode.test.ts — unit tests for the Avantis scene→MIDI encoder.
//
// Run: bun test  (from v2/). Spec-verified reference values (§7):
//   scene  96, ch 1 -> B0 00 00 C0 5F
//   scene 264, ch 1 -> B0 00 02 C0 07
// plus a base-channel-5 case exercising the ch nibble on both status bytes.

import { test, expect } from "bun:test";
import { sceneToMidi, toHex } from "./avantisEncode";

test("scene 96 on base channel 1 -> B0 00 00 C0 5F (spec example)", () => {
  const m = sceneToMidi(96, 1);
  expect(m.hex).toBe("B0 00 00 C0 5F");
  expect(m.bytes).toEqual([0xb0, 0x00, 0x00, 0xc0, 0x5f]);
});

test("scene 264 on base channel 1 -> B0 00 02 C0 07 (spec example, bank rollover)", () => {
  const m = sceneToMidi(264, 1);
  expect(m.hex).toBe("B0 00 02 C0 07");
  expect(m.bytes).toEqual([0xb0, 0x00, 0x02, 0xc0, 0x07]);
});

test("base channel 5 sets the channel nibble on both status bytes", () => {
  // ch = 5 - 1 = 4 → status bytes 0xB4 / 0xC4; data bytes unchanged.
  const m = sceneToMidi(96, 5);
  expect(m.hex).toBe("B4 00 00 C4 5F");
  expect(m.bytes).toEqual([0xb4, 0x00, 0x00, 0xc4, 0x5f]);
});

test("scene 1 and scene 500 sit at the ends of the valid range", () => {
  expect(sceneToMidi(1, 1).hex).toBe("B0 00 00 C0 00"); // n=0 → bank 0, prog 0
  // scene 500 → n=499, bank=499>>7=3, prog=499&0x7F=115=0x73
  expect(sceneToMidi(500, 1).hex).toBe("B0 00 03 C0 73");
});

test("invalid scene / channel inputs are rejected", () => {
  expect(() => sceneToMidi(0, 1)).toThrow();
  expect(() => sceneToMidi(501, 1)).toThrow();
  expect(() => sceneToMidi(1.5, 1)).toThrow();
  expect(() => sceneToMidi(96, 0)).toThrow();
  expect(() => sceneToMidi(96, 17)).toThrow();
});

test("toHex renders uppercase, zero-padded, space-separated bytes", () => {
  expect(toHex([0x00, 0x0f, 0xb0, 0xff])).toBe("00 0F B0 FF");
});
