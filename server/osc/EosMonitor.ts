// server/osc/EosMonitor.ts — live "what cue is the console in" mirror.
//
// The Eos family streams its state changes (implicit OSC output) to every
// client connected on its OSC TCP port (3032) — including
//   /eos/out/active/cue/<list>/<number>       (fired cue identity)
//   /eos/out/active/cue/text  "1/12 Label …"  (display string)
// This monitor keeps one persistent TCP connection per production's console,
// decodes those messages, and reports the active cue upward (the hub broadcasts
// it to the crew). It is strictly read-only and fully independent of the fire
// path: firing can stay on UDP 8000 while this listens on TCP 3032.
//
// Framing: BOTH console settings are supported and auto-detected —
//   "OSC 1.0": int32 BE packet-length prefix
//   "OSC 1.1": SLIP (0xC0-delimited frames, 0xDB escapes) — the default on
//              newer Eos software, and the reason a fresh install "doesn't
//              show the cue" when only 1.0 is spoken.
// Each connection attempt speaks ONE framing (our /eos/subscribe handshake
// must match what the console parses); if nothing valid is decoded within a
// few seconds the monitor reconnects with the other framing and sticks with
// whichever produced real OSC. On connect we send `/eos/subscribe = 1` so the
// console reports its current state immediately instead of on the next GO.

import net from "node:net";
import { encodeOsc } from "./OscService";
import type { EosActiveCue } from "../../shared/protocol";

const EOS_TCP_PORT = Number(process.env.SCRIPTWARDEN_EOS_TCP_PORT ?? 3032);
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30_000;
const MAX_PACKET = 1 << 20; // 1MB — anything larger means we lost framing
const SETTLE_MS = 3000; // no valid OSC decoded in this window → try the other framing

// --- SLIP (RFC 1055) — OSC 1.1 TCP framing ------------------------------------

const SLIP_END = 0xc0;
const SLIP_ESC = 0xdb;
const SLIP_ESC_END = 0xdc;
const SLIP_ESC_ESC = 0xdd;

export function slipEncode(packet: Buffer): Buffer {
  const out: number[] = [SLIP_END];
  for (const b of packet) {
    if (b === SLIP_END) out.push(SLIP_ESC, SLIP_ESC_END);
    else if (b === SLIP_ESC) out.push(SLIP_ESC, SLIP_ESC_ESC);
    else out.push(b);
  }
  out.push(SLIP_END);
  return Buffer.from(out);
}

function slipUnescape(frame: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < frame.length; i++) {
    if (frame[i] === SLIP_ESC && i + 1 < frame.length) {
      i++;
      out.push(frame[i] === SLIP_ESC_END ? SLIP_END : frame[i] === SLIP_ESC_ESC ? SLIP_ESC : frame[i]);
    } else {
      out.push(frame[i]);
    }
  }
  return Buffer.from(out);
}

// --- minimal OSC 1.0 decoder (address + s/i/f args) ---------------------------

function pad4(n: number): number {
  return (n + 3) & ~3;
}

export function decodeOsc(packet: Buffer): { address: string; args: (string | number)[] } | null {
  try {
    let off = 0;
    const readString = (): string => {
      const end = packet.indexOf(0, off);
      if (end < 0) throw new Error("unterminated string");
      const s = packet.toString("ascii", off, end);
      off = pad4(end + 1);
      return s;
    };
    const address = readString();
    if (!address.startsWith("/")) return null;
    const args: (string | number)[] = [];
    if (off < packet.length && packet[off] === 0x2c /* ',' */) {
      const tags = readString();
      for (const t of tags.slice(1)) {
        if (t === "s") args.push(readString());
        else if (t === "i") {
          args.push(packet.readInt32BE(off));
          off += 4;
        } else if (t === "f") {
          args.push(packet.readFloatBE(off));
          off += 4;
        } else if (t === "T") args.push(1);
        else if (t === "F") args.push(0);
        else if (t === "N") args.push(0);
        else if (t === "d") {
          args.push(packet.readDoubleBE(off));
          off += 8;
        } else {
          // Unknown tag — bail rather than misread the rest.
          break;
        }
      }
    }
    return { address, args };
  } catch {
    return null;
  }
}

// --- per-console monitor -------------------------------------------------------

export interface EosMonitorStatus {
  connected: boolean;
  cue: EosActiveCue | null;
}

type ChangeListener = (status: EosMonitorStatus) => void;

class EosMonitor {
  private ip = "";
  private enabled = false;
  private sock: net.Socket | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private connected = false;
  private cue: EosActiveCue | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = RECONNECT_MIN_MS;
  private destroyed = false;
  // Framing for THIS connection attempt. Sticky once a valid packet decodes
  // (settled); flips to the other framing when a connection stays silent.
  private mode: "len" | "slip" = "len";
  private settled = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private onChange: ChangeListener) {}

  // Reconfigure from the production row. Connects when enabled+ip, tears down
  // otherwise. Safe to call repeatedly (route patches, room boot).
  configure(ip: string, enabled: boolean): void {
    if (ip === this.ip && enabled === this.enabled) return;
    // A different console may use the other framing — redetect from scratch.
    if (ip !== this.ip) {
      this.settled = false;
      this.mode = "len";
    }
    this.ip = ip;
    this.enabled = enabled;
    this.teardown(false);
    if (this.enabled && this.ip) this.connect();
  }

  status(): EosMonitorStatus {
    return { connected: this.connected, cue: this.cue };
  }

  destroy(): void {
    this.destroyed = true;
    this.teardown(false);
  }

  private connect(): void {
    if (this.destroyed || this.sock) return;
    const sock = net.createConnection({ host: this.ip, port: EOS_TCP_PORT });
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    sock.on("connect", () => {
      console.log(`[eos-mon] connected to ${this.ip}:${EOS_TCP_PORT} (framing: ${this.mode === "len" ? "OSC 1.0" : "OSC 1.1/SLIP"})`);
      this.connected = true;
      this.backoff = RECONNECT_MIN_MS;
      // Ask the console to report its current state now (standard Eos client
      // handshake) — otherwise nothing arrives until the next cue fires.
      this.sendPacket(encodeOsc("/eos/subscribe", [1]));
      // If this framing decodes nothing, flip to the other one and reconnect.
      if (!this.settled) {
        this.settleTimer = setTimeout(() => {
          this.settleTimer = null;
          if (!this.settled) {
            const next = this.mode === "len" ? "slip" : "len";
            console.log(`[eos-mon] no OSC decoded as ${this.mode} — retrying with ${next} framing`);
            this.mode = next;
            this.teardown(false);
            this.connect();
          }
        }, SETTLE_MS);
      }
      this.emit();
    });
    sock.on("data", (chunk: Buffer) => this.onData(chunk));
    sock.on("error", (e) => {
      // Quiet: an unplugged console is normal life in a booth.
      console.log(`[eos-mon] ${this.ip}:${EOS_TCP_PORT} error: ${e.message}`);
    });
    sock.on("close", () => {
      const wasConnected = this.connected;
      this.teardown(true);
      if (wasConnected) this.emit();
    });
  }

  private sendPacket(packet: Buffer): void {
    if (!this.sock) return;
    try {
      if (this.mode === "len") {
        const len = Buffer.alloc(4);
        len.writeInt32BE(packet.length);
        this.sock.write(Buffer.concat([len, packet]));
      } else {
        this.sock.write(slipEncode(packet));
      }
    } catch {
      /* connection is going away — the close handler reconnects */
    }
  }

  private teardown(scheduleRetry: boolean): void {
    if (this.sock) {
      this.sock.removeAllListeners();
      this.sock.destroy();
      this.sock = null;
    }
    this.connected = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (scheduleRetry && this.enabled && this.ip && !this.destroyed) {
      const delay = this.backoff;
      this.backoff = Math.min(RECONNECT_MAX_MS, this.backoff * 2);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.connect();
      }, delay);
    }
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (this.mode === "len") this.drainLen();
    else this.drainSlip();
  }

  private drainLen(): void {
    while (this.buf.length >= 4) {
      const len = this.buf.readInt32BE(0);
      if (len <= 0 || len > MAX_PACKET) {
        if (!this.settled) {
          // Wrong guess — this is almost certainly a SLIP stream (0xC0-first).
          console.log("[eos-mon] stream is not length-framed — switching to SLIP framing");
          this.mode = "slip";
          this.teardown(false);
          this.connect();
        } else {
          console.error(`[eos-mon] lost OSC framing (len=${len}) — dropping buffer`);
          this.buf = Buffer.alloc(0);
        }
        return;
      }
      if (this.buf.length < 4 + len) return; // wait for the rest
      const packet = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      this.decoded(packet);
    }
  }

  private drainSlip(): void {
    let end: number;
    while ((end = this.buf.indexOf(SLIP_END)) >= 0) {
      const frame = this.buf.subarray(0, end);
      this.buf = this.buf.subarray(end + 1);
      if (frame.length === 0) continue; // leading/double delimiter
      this.decoded(slipUnescape(frame));
    }
    if (this.buf.length > MAX_PACKET) this.buf = Buffer.alloc(0); // runaway garbage
  }

  private decoded(packet: Buffer): void {
    const msg = decodeOsc(packet);
    if (!msg) return;
    if (!this.settled) {
      this.settled = true; // this framing works — stick with it
      if (this.settleTimer) {
        clearTimeout(this.settleTimer);
        this.settleTimer = null;
      }
    }
    this.handle(msg.address, msg.args);
  }

  private handle(address: string, args: (string | number)[]): void {
    // /eos/out/active/cue/<list>/<number>  → cue identity (fired)
    // /eos/out/active/cue/text             → "1/12 Label 3.0 100%"
    // /eos/out/active/cue                  → percent complete (ignored)
    const m = address.match(/^\/eos\/out\/active\/cue\/(\d+)\/([\d.]+)$/);
    if (m) {
      const next: EosActiveCue = { list: Number(m[1]), number: m[2], text: this.cue?.text ?? "" };
      if (this.cue?.list !== next.list || this.cue?.number !== next.number) {
        this.cue = next;
        this.emit();
      }
      return;
    }
    if (address === "/eos/out/active/cue/text") {
      const text = String(args[0] ?? "").trim();
      if (!text) {
        // Empty text = no active cue on the console.
        if (this.cue !== null) {
          this.cue = null;
          this.emit();
        }
        return;
      }
      if (this.cue) {
        if (this.cue.text !== text) {
          this.cue = { ...this.cue, text };
          this.emit();
        }
      } else {
        // Text arrived without (or before) an identity message — parse the
        // leading "list/number" from Eos's display string as a fallback.
        const t = text.match(/^(\d+)\/([\d.]+)/);
        this.cue = { list: t ? Number(t[1]) : 1, number: t ? t[2] : "", text };
        this.emit();
      }
    }
  }

  private emit(): void {
    this.onChange(this.status());
  }
}

// --- registry: one monitor per production --------------------------------------

class EosMonitors {
  private map = new Map<number, EosMonitor>();
  private listeners = new Map<number, ChangeListener>();

  // (Re)configure the monitor for a production. `onChange` is registered once
  // per production (first caller wins — it's always the hub broadcast).
  sync(productionId: number, ip: string, enabled: boolean, onChange: ChangeListener): void {
    let mon = this.map.get(productionId);
    if (!mon) {
      this.listeners.set(productionId, onChange);
      mon = new EosMonitor((s) => this.listeners.get(productionId)?.(s));
      this.map.set(productionId, mon);
    }
    mon.configure(ip, enabled);
  }

  status(productionId: number): EosMonitorStatus {
    return this.map.get(productionId)?.status() ?? { connected: false, cue: null };
  }
}

export const eosMonitors = new EosMonitors();
