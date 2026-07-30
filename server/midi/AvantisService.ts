// server/midi/AvantisService.ts — Allen & Heath Avantis scene recall over
// MIDI-over-TCP (DESIGN §7). Mirrors OscService: config / log ring 200 /
// stub-first / singleton reconfigured per production before each fire.
//
// Transport: a lazy persistent TCP socket to <ip>:51325 (the desk's plain MIDI
// port; TLS on 51327 is out of scope). On error/close we mark the socket
// disconnected and reconnect on the next send (3s connect timeout). Transport
// failures are logged, NEVER thrown into the fire path — a dead console must
// not take the show system down. We always send full status bytes (running
// status is something the console may emit, not something it requires of us).

import net from "node:net";
import { sceneToMidi } from "../../shared/avantisEncode";
import type { AvantisLogEntry } from "../../shared/protocol";

export interface AvantisConfig {
  enabled: boolean;
  ip: string;
  port: number;
  baseChannel: number; // 1..16
}

const DEFAULT_CONFIG: AvantisConfig = {
  enabled: false,
  ip: "",
  port: 51325,
  baseChannel: 1,
};

const CONNECT_TIMEOUT_MS = 3000;

export class AvantisService {
  private cfg: AvantisConfig;
  private log: AvantisLogEntry[] = [];
  private sock: net.Socket | null = null;
  private connected = false;

  constructor(cfg: Partial<AvantisConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
  }

  configure(cfg: Partial<AvantisConfig>): void {
    const next = { ...this.cfg, ...cfg };
    // A new target invalidates the current socket.
    if (next.ip !== this.cfg.ip || next.port !== this.cfg.port) this.teardown();
    this.cfg = next;
  }
  getConfig(): AvantisConfig {
    return this.cfg;
  }
  getLog(): AvantisLogEntry[] {
    return this.log;
  }
  clearLog(): void {
    this.log = [];
  }

  private record(hex: string, preview: string, sent: boolean): AvantisLogEntry {
    const entry: AvantisLogEntry = {
      ts: new Date().toISOString(),
      hex,
      preview,
      sent,
      target: this.cfg.ip ? `${this.cfg.ip}:${this.cfg.port}` : undefined,
    };
    this.log.unshift(entry);
    if (this.log.length > 200) this.log.length = 200;
    console.log(`[avantis] ${sent ? "SENT" : "STUB"} ${preview}${hex ? ` (${hex})` : ""}`);
    return entry;
  }

  private teardown(): void {
    if (this.sock) {
      this.sock.removeAllListeners();
      this.sock.destroy();
      this.sock = null;
    }
    this.connected = false;
  }

  // Lazily (re)connect, then write. Fire-and-forget: the fire path only needs
  // to know whether we handed the bytes to a live socket. A connect that is
  // still in flight queues the write inside node:net (write() buffers until
  // 'connect'), which is exactly the behavior we want for back-to-back GOs.
  private transmit(bytes: number[]): boolean {
    if (!this.cfg.enabled || !this.cfg.ip) return false;
    if (!this.sock) {
      const sock = net.createConnection({
        host: this.cfg.ip,
        port: this.cfg.port,
        timeout: CONNECT_TIMEOUT_MS,
      });
      sock.on("connect", () => {
        this.connected = true;
        sock.setTimeout(0); // timeout only guards the connect phase
      });
      sock.on("timeout", () => {
        if (!this.connected) {
          console.error(`[avantis] connect timeout to ${this.cfg.ip}:${this.cfg.port}`);
          this.teardown();
        }
      });
      sock.on("error", (e) => {
        console.error(`[avantis] socket error (${this.cfg.ip}:${this.cfg.port}):`, e.message);
        this.teardown();
      });
      sock.on("close", () => {
        // Desk went away — reconnect on the next send.
        if (this.sock === sock) this.teardown();
      });
      // Ignore anything the desk sends back (MIDI echo / active sensing).
      sock.on("data", () => {});
      this.sock = sock;
    }
    try {
      this.sock.write(Buffer.from(bytes));
      return true;
    } catch (e) {
      console.error("[avantis] write failed:", (e as Error).message);
      this.teardown();
      return false;
    }
  }

  // Recall a scene (1..500). Invalid input becomes a logged stub entry — the
  // fire path never throws.
  recallScene(scene: number): AvantisLogEntry {
    try {
      const midi = sceneToMidi(scene, this.clampChannel(this.cfg.baseChannel));
      const sent = this.transmit(midi.bytes);
      return this.record(midi.hex, `Avantis scene ${scene}`, sent);
    } catch (e) {
      return this.record("", `Avantis scene ${scene} (invalid: ${(e as Error).message})`, false);
    }
  }

  private clampChannel(ch: number): number {
    const n = Math.trunc(Number(ch) || 1);
    return Math.min(16, Math.max(1, n));
  }
}

// Singleton reused across requests; reconfigured per-production before firing.
export const avantis = new AvantisService();
