import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "web",
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    // Vite's default esbuild minifier currently produces a broken xterm.js bundle
    // (runtime ReferenceError inside `requestMode`). This is catastrophic on mobile
    // because it triggers our boot overlay "Startup error" and blocks interaction.
    // Disabling minification keeps the bundle correct and the UI reliable.
    minify: false,
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
