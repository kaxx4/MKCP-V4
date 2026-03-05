import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    target: "esnext",
    chunkSizeWarningLimit: 1500,
  },
  server: {
    proxy: {
      "/api/tally": {
        target: "http://localhost:3100",
        changeOrigin: true,
      },
    },
  },
});
