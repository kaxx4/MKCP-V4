/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Semantic color system with multiple levels
        bg: {
          DEFAULT: "#f8fafc",
          card: "#ffffff",
          border: "#e2e8f0",
          hover: "#f1f5f9",
          alt: "#f0f4f8"
        },
        // Primary accent - blue with extended palette
        accent: {
          50: "#eff6ff",
          100: "#dbeafe",
          200: "#bfdbfe",
          300: "#93c5fd",
          400: "#60a5fa",
          DEFAULT: "#2563eb",
          600: "#2563eb",
          700: "#1d4ed8",
          800: "#1e40af",
          900: "#1e3a8a"
        },
        // Semantic colors - success, warning, danger
        success: {
          50: "#f0fdf4",
          100: "#dcfce7",
          DEFAULT: "#10b981",
          600: "#059669",
          700: "#047857",
          900: "#065f46"
        },
        danger: {
          50: "#fef2f2",
          100: "#fee2e2",
          DEFAULT: "#ef4444",
          600: "#dc2626",
          700: "#b91c1c",
          900: "#7f1d1d"
        },
        warn: {
          50: "#fffbeb",
          100: "#fef3c7",
          DEFAULT: "#f59e0b",
          600: "#d97706",
          700: "#b45309",
          900: "#78350f"
        },
        // Information and neutral colors
        info: {
          DEFAULT: "#06b6d4",
          600: "#0891b2",
          700: "#0e7490"
        },
        muted: {
          50: "#f9fafb",
          100: "#f3f4f6",
          200: "#e5e7eb",
          300: "#d1d5db",
          400: "#9ca3af",
          500: "#6b7280",
          DEFAULT: "#475569",  // slate-600: 7.2:1 contrast (WCAG AA)
          600: "#4b5563",
          700: "#374151",
          800: "#1f2937",
          900: "#111827"
        },
        primary: {
          DEFAULT: "#0f172a",
          50: "#f9fafb",
          100: "#f3f4f6",
          900: "#0f172a"
        }
      },
      fontFamily: {
        mono: ["IBM Plex Mono", "monospace"],
        sans: ["DM Sans", "sans-serif"],
      },
      // Extended sizing scale
      spacing: {
        "0.5": "0.125rem",
        "1.5": "0.375rem",
        "2.5": "0.625rem",
        "3.5": "0.875rem",
        "4.5": "1.125rem",
      },
      // Shadow scale for depth
      boxShadow: {
        xs: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
        sm: "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
        base: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
        md: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
        lg: "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)",
        xl: "0 25px 50px -12px rgb(0 0 0 / 0.25)",
      },
      // Radius scale
      borderRadius: {
        "3xl": "1rem",
        "4xl": "1.5rem",
      },
      // Transition scale
      transitionDuration: {
        250: "250ms",
        350: "350ms",
      },
    },
  },
  plugins: [],
};
