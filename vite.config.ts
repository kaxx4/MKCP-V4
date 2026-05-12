import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  define: {
    "process.env.ELECTRON_MODE": JSON.stringify(
      process.env.ELECTRON_MODE || "false"
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
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          // Lucide icon tree (large — isolate so it's only parsed once)
          "vendor-icons": ["lucide-react"],
          // State management
          "vendor-state": ["zustand"],
          // Recharts — heavy chart engine, only needed by Reports/Dashboard/Orders
          "vendor-charts": ["recharts"],
          // xlsx — loaded lazily on first export action, never on page load
          "vendor-xlsx": ["xlsx"],
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
