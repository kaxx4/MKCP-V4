import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

export default defineConfig({
  plugins: [react()],
  base: "./",
  define: {
    "process.env.ELECTRON_MODE": JSON.stringify(
      process.env.ELECTRON_MODE || "false"
    ),
    /* The renderer needs to know which build it IS, so it can tell whether the
       server answering on port 3100 is its own. A stale standalone
       `node dist/index.js` from a previous session holds the port, the new
       app's server never binds (EADDRINUSE is logged to a console nobody
       reads), and the UI then talks to yesterday's build while showing advice
       about an .env that was already correct. Observed 14-Sep-2026. */
    "__APP_VERSION__": JSON.stringify(
      JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version,
    ),
  },
  build: {
    target: "esnext",
    outDir: "dist",
    chunkSizeWarningLimit: 1500,
    sourcemap: false,
    minify: "esbuild",
    cssCodeSplit: false,          // single CSS bundle is faster for Electron file:// loads
    reportCompressedSize: false,  // skip per-file gzip measurement → ~3s faster builds
    modulePreload: { polyfill: false }, // Electron Chromium supports modulepreload natively
    rollupOptions: {
      output: {
        experimentalMinChunkSize: 10_000, // absorb tiny stub chunks (<10KB) into consumers
        manualChunks: {
          // React core — loaded first, cached longest
          "vendor-react": ["react", "react-dom"],
          // Lucide icon tree (large — isolate so it's only parsed once)
          "vendor-icons": ["lucide-react"],
          // State management
          "vendor-state": ["zustand"],
          // Supabase client (realtime + auth)
          "vendor-supabase": ["@supabase/supabase-js"],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api/tally": {
        target: "http://localhost:3100",
        changeOrigin: true,
        timeout: 600000,
        proxyTimeout: 600000,
      },
    },
  },
});
