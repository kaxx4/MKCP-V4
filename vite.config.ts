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
    cssCodeSplit: false, // single CSS bundle is faster for Electron file:// loads
    rollupOptions: {
      output: {
        manualChunks: {
          // React core — loaded first, cached longest
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          // Lucide icon tree (large — isolate so it's only parsed once)
          "vendor-icons": ["lucide-react"],
          // State management
          "vendor-state": ["zustand"],
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
