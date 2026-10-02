import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In --dev mode the companion server runs separately; proxy API calls to it so the UI stays same-origin.
const apiPort = process.env.CONFIGURATOR_PORT ?? "4280";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } },
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
});
