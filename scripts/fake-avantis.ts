// scripts/fake-avantis.ts — fake Avantis console for transport verification
// (DESIGN §9 M4). Listens on TCP 51325 and prints every received byte run as
// hex, so you can point ScriptWarden at 127.0.0.1, enable Avantis live send,
// test-fire a scene and confirm the bytes on the wire:
//
//   scene  96, ch 1 -> B0 00 00 C0 5F
//   scene 264, ch 1 -> B0 00 02 C0 07
//
// Run with: bun scripts/fake-avantis.ts [port]

import net from "node:net";

const port = Number(process.argv[2] ?? 51325);

const server = net.createServer((sock) => {
  const peer = `${sock.remoteAddress}:${sock.remotePort}`;
  console.log(`[fake-avantis] connection from ${peer}`);
  sock.on("data", (buf: Buffer) => {
    const hex = [...buf].map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
    console.log(`[fake-avantis] ${peer} -> ${hex}`);
  });
  sock.on("close", () => console.log(`[fake-avantis] ${peer} disconnected`));
  sock.on("error", (e) => console.log(`[fake-avantis] ${peer} error: ${e.message}`));
});

server.listen(port, () => {
  console.log(`[fake-avantis] listening on tcp://0.0.0.0:${port} — Ctrl+C to stop`);
});
