import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: Vite serves the UI on 5174 and proxies /api + /ws to the Bun API on 3002.
// host:true exposes the dev server on the LAN (phones/tablets join over wifi).
// Prod: `vite build` -> dist/, which the Bun server serves directly.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    host: true,
    proxy: {
      "/api": "http://localhost:3002",
      // WebSocket upgrade for the live-sync hub (M1+). ws:true so the proxy
      // forwards the Upgrade handshake; no config change needed when the hub lands.
      "/ws": { target: "ws://localhost:3002", ws: true },
    },
  },
  build: {
    outDir: "dist",
  },
});
