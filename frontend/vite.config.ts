import { existsSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wails from "@wailsio/runtime/plugins/vite";

// The Wails plugin needs generated bindings (desktop build). The web/server
// build (Docker) has none and talks to the HTTP API instead.
const hasBindings = existsSync("./bindings/github.com/wailsapp/wails/v3/internal/eventcreate.ts");

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WAILS_VITE_PORT) || 9245,
    strictPort: true,
    // `VITE_SHUAKE_SERVER=1 pnpm dev` develops the web UI against a running shuake-server.
    proxy: process.env.VITE_SHUAKE_SERVER === "1"
      ? { "/api": { target: process.env.SHUAKE_API || "http://127.0.0.1:8080", changeOrigin: false } }
      : undefined,
  },
  plugins: [react(), ...(hasBindings ? [wails("./bindings")] : [])],
});
