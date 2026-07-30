// scripts/fake-eos.ts — fake Ion/Eos console for the cue-monitor (EosMonitor).
// Listens on the OSC TCP port (3032) and, to every client that connects, sends
// the OSC 1.0 length-framed implicit output a real console would:
//   /eos/out/active/cue/1/<n>
//   /eos/out/active/cue/text "1/<n> Demo cue <n> 3.0 100%"
// advancing the cue number every 5 seconds. Point ScriptWarden's Console IP at
// 127.0.0.1, enable live send, and the lights operator's standby card should
// show "Ion at Q 1/<n>" ticking.
//
// Run with: bun scripts/fake-eos.ts [port] [--slip]
//   --slip emulates a console set to "OSC 1.1" (SLIP framing, the default on
//   newer Eos software) — the monitor should auto-detect either.

import net from "node:net";
import { encodeOsc } from "../server/osc/OscService";
import { slipEncode } from "../server/osc/EosMonitor";

const args = process.argv.slice(2);
const slip = args.includes("--slip");
const port = Number(args.find((a) => !a.startsWith("--")) ?? 3032);

function frame(address: string, fargs: (string | number)[] = []): Buffer {
  const pkt = encodeOsc(address, fargs);
  if (slip) return slipEncode(pkt);
  const len = Buffer.alloc(4);
  len.writeInt32BE(pkt.length);
  return Buffer.concat([len, pkt]);
}

let cueNo = 10;
const clients = new Set<net.Socket>();

function sendCue(sock: net.Socket): void {
  sock.write(frame(`/eos/out/active/cue/1/${cueNo}`));
  sock.write(frame("/eos/out/active/cue/text", [`1/${cueNo} Demo cue ${cueNo} 3.0 100%`]));
}

const server = net.createServer((sock) => {
  const peer = `${sock.remoteAddress}:${sock.remotePort}`;
  console.log(`[fake-eos] client connected: ${peer}`);
  clients.add(sock);
  sendCue(sock); // consoles report current state to a fresh client
  sock.on("close", () => {
    clients.delete(sock);
    console.log(`[fake-eos] ${peer} disconnected`);
  });
  sock.on("error", () => clients.delete(sock));
});

setInterval(() => {
  cueNo++;
  console.log(`[fake-eos] advancing to cue 1/${cueNo}`);
  for (const c of clients) sendCue(c);
}, 5000);

server.listen(port, () => {
  console.log(
    `[fake-eos] listening on tcp://0.0.0.0:${port} (${slip ? "OSC 1.1/SLIP" : "OSC 1.0/length"} framing) — Ctrl+C to stop`,
  );
});
