import dgram from "node:dgram";
import net from "node:net";

// --- Minimal OSC 1.0 encoder ------------------------------------------------
// OSC's wire format is trivial for our needs (string address, optional string/
// int/float args), so we encode it by hand rather than take a dependency that
// may not play nicely with Bun's node:dgram shim. Validated against ETC Nomad
// before we ever trust live send.

type OscArg = string | number;

function padTo4(len: number): number {
  return (4 - (len % 4)) % 4;
}

function encodeString(s: string): Buffer {
  const base = Buffer.concat([Buffer.from(s, "ascii"), Buffer.from([0])]);
  return Buffer.concat([base, Buffer.alloc(padTo4(base.length))]);
}

export function encodeOsc(address: string, args: OscArg[] = []): Buffer {
  const parts: Buffer[] = [encodeString(address)];
  let typeTag = ",";
  const argBufs: Buffer[] = [];
  for (const a of args) {
    if (typeof a === "string") {
      typeTag += "s";
      argBufs.push(encodeString(a));
    } else if (Number.isInteger(a)) {
      typeTag += "i";
      const b = Buffer.alloc(4);
      b.writeInt32BE(a);
      argBufs.push(b);
    } else {
      typeTag += "f";
      const b = Buffer.alloc(4);
      b.writeFloatBE(a);
      argBufs.push(b);
    }
  }
  parts.push(encodeString(typeTag), ...argBufs);
  return Buffer.concat(parts);
}

// --- Cue -> OSC message mapping ---------------------------------------------

export type FireMode = "fire" | "go" | "cmd";

export interface CueLike {
  cue_list: number;
  cue_number: string;
  fire_mode: FireMode;
  cmd_text: string;
}

// Build the /eos/... address + args for a cue WITHOUT sending. This is the
// piece we verify in show mode before any hardware is involved.
export function buildCueMessage(cue: CueLike): { address: string; args: OscArg[] } {
  switch (cue.fire_mode) {
    case "go":
      return { address: "/eos/key/go_0", args: [] };
    case "cmd":
      return { address: "/eos/cmd", args: [cue.cmd_text] };
    case "fire":
    default:
      return {
        address: `/eos/cue/${cue.cue_list}/${cue.cue_number}/fire`,
        args: [],
      };
  }
}

// --- Service ----------------------------------------------------------------

export interface OscConfig {
  enabled: boolean;
  ip: string;
  port: number;
  protocol: "udp" | "tcp";
}

export interface OscLogEntry {
  ts: string;
  address: string;
  args: OscArg[];
  preview: string; // human-readable, e.g. "/eos/cue/1/12/fire"
  sent: boolean; // true = transmitted, false = stubbed (logged only)
  target?: string;
}

const DEFAULT_CONFIG: OscConfig = {
  enabled: false,
  ip: "",
  port: 8000,
  protocol: "udp",
};

export class OscService {
  private cfg: OscConfig;
  private log: OscLogEntry[] = [];

  constructor(cfg: Partial<OscConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
  }

  configure(cfg: Partial<OscConfig>): void {
    this.cfg = { ...this.cfg, ...cfg };
  }
  getConfig(): OscConfig {
    return this.cfg;
  }
  getLog(): OscLogEntry[] {
    return this.log;
  }
  clearLog(): void {
    this.log = [];
  }

  private preview(address: string, args: OscArg[]): string {
    return args.length ? `${address} ${args.map(String).join(" ")}` : address;
  }

  private record(address: string, args: OscArg[], sent: boolean): OscLogEntry {
    const entry: OscLogEntry = {
      ts: new Date().toISOString(),
      address,
      args,
      preview: this.preview(address, args),
      sent,
      target: sent ? `${this.cfg.ip}:${this.cfg.port} (${this.cfg.protocol})` : undefined,
    };
    this.log.unshift(entry);
    if (this.log.length > 200) this.log.length = 200;
    console.log(`[osc] ${sent ? "SENT" : "STUB"} ${entry.preview}`);
    return entry;
  }

  // Returns true if actually transmitted; false when stubbed.
  private transmit(packet: Buffer): boolean {
    if (!this.cfg.enabled || !this.cfg.ip) return false;
    if (this.cfg.protocol === "udp") {
      const sock = dgram.createSocket("udp4");
      sock.send(packet, this.cfg.port, this.cfg.ip, () => sock.close());
    } else {
      // OSC-over-TCP (OSC 1.0): int32 length prefix + packet.
      const framed = Buffer.concat([
        (() => {
          const b = Buffer.alloc(4);
          b.writeInt32BE(packet.length);
          return b;
        })(),
        packet,
      ]);
      const sock = net.createConnection(this.cfg.port, this.cfg.ip, () => {
        sock.write(framed, () => sock.end());
      });
      sock.on("error", (e) => console.error("[osc] tcp error", e.message));
    }
    return true;
  }

  send(address: string, args: OscArg[] = []): OscLogEntry {
    const sent = this.transmit(encodeOsc(address, args));
    return this.record(address, args, sent);
  }

  fireCue(cue: CueLike): OscLogEntry {
    const m = buildCueMessage(cue);
    return this.send(m.address, m.args);
  }
  go(): OscLogEntry {
    return this.send("/eos/key/go_0", []);
  }
  sendCommand(text: string): OscLogEntry {
    return this.send("/eos/cmd", [text]);
  }
}

// Singleton reused across requests; reconfigured per-production before firing.
export const osc = new OscService();
