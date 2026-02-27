/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: { DEFAULT: "#ffffff", card: "#f8fafc", border: "#e2e8f0" },
        accent: { DEFAULT: "#f59e0b", hover: "#d97706" },
        success: "#10b981",
        danger: "#ef4444",
        warn: "#f59e0b",
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
