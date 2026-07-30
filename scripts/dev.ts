// Runs the API server (with --watch) and the Vite dev server together.
// Usage: bun dev
import { spawn } from "bun";

const opts = { stdout: "inherit", stderr: "inherit", stdin: "inherit" } as const;

const server = spawn({ cmd: ["bun", "--watch", "server/index.ts"], ...opts });
const web = spawn({ cmd: ["bunx", "vite"], ...opts });

function shutdown() {
  server.kill();
  web.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// If either process exits, tear the other down too.
await Promise.race([server.exited, web.exited]);
shutdown();
