import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import "./db"; // side-effect: open DB + apply schema
import { registerProductions } from "./routes/productions";
import { registerScript } from "./routes/script";
import { registerCharacters } from "./routes/characters";
import { registerSongs } from "./routes/songs";
import { registerCues } from "./routes/cues";
import { registerOsc } from "./routes/osc";
import { registerAvantis } from "./routes/avantis";
import { registerSession } from "./routes/session";
import { hub, type WsData } from "./ws/hub";

const app = new Hono();

app.get("/api/health", (c) => c.json({ ok: true, service: "scriptwarden" }));

registerProductions(app);
registerScript(app);
registerCharacters(app);
registerSongs(app);
registerCues(app);
registerOsc(app);
registerAvantis(app);
registerSession(app);

// In production, serve the built Vite bundle (SPA) from ./dist.
if (process.env.NODE_ENV === "production") {
  app.use("/assets/*", serveStatic({ root: "./dist" }));
  app.get("/*", serveStatic({ path: "./dist/index.html" }));
}

const port = Number(process.env.PORT ?? 3002);

// Bun.serve wrapper (§4.1): the /ws path is upgraded to a WebSocket (token from
// the query string, stashed in ws.data); everything else is delegated to Hono.
// hostname 0.0.0.0 exposes the API on the LAN so phones/tablets can join.
const server = Bun.serve<WsData>({
  port,
  hostname: "0.0.0.0",
  idleTimeout: 60,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const token = url.searchParams.get("token") ?? "";
      // On success Bun handles the handshake and hub.open takes over.
      if (srv.upgrade(req, { data: { token } })) return undefined;
      return new Response("websocket upgrade failed", { status: 400 });
    }
    return app.fetch(req, srv);
  },
  websocket: hub.handlers,
});

// Give the hub the server instance so it (and the HTTP routes) can publish.
hub.bind(server);

console.log(`[scriptwarden] listening on http://0.0.0.0:${port} (ws: /ws)`);

export default server;
