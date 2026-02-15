import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "web",
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
  server: {
    strictPort: true,
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:7337",
      "/ws": {
        target: "ws://127.0.0.1:7337",
        ws: true,
      },
    },
  },
});
