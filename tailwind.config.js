/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: { DEFAULT: "#ffffff", card: "#f8fafc", border: "#e2e8f0" },
        accent: { DEFAULT: "#2563eb", hover: "#1d4ed8" },  // blue-600 / blue-700
        success: "#10b981",
        danger: "#ef4444",
        warn: "#f59e0b",  // keep warn as yellow (contextually correct for warnings)
        muted: "#64748b",
        primary: "#0f172a",
      },
      fontFamily: {
        mono: ["IBM Plex Mono", "monospace"],
        sans: ["DM Sans", "sans-serif"],
      },
    },
  },
  plugins: [],
};
