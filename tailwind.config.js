/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // ─────────────────────────────────────────────────────────────
        // APPLE HIG DESIGN SYSTEM - Light Mode
        // ─────────────────────────────────────────────────────────────

        // ─── Background & Surface System ─────────────────────────────
        // Refined neutral palette inspired by Apple's iOS design
        bg: {
          DEFAULT: "#ffffff",       // Page/app background (light mode)
          secondary: "#f5f5f7",     // Secondary background (subtle grouping)
          tertiary: "#ffffff",      // Tertiary (elevated surfaces)
          hover: "#f5f5f7",         // Hover state background
          border: "#e5e5ea",        // Borders, dividers, subtle separators
          input: "#ffffff",         // Input field backgrounds
          muted: "#f5f5f7",         // Muted/disabled backgrounds
        },

        // ─── Primary Accent (Blue) ──────────────────────────────────
        // Kept as specified by user (#2563eb)
        accent: {
          50: "#f0f9ff",
          100: "#e0f2fe",
          200: "#bae6fd",
          300: "#7dd3fc",
          400: "#38bdf8",
          DEFAULT: "#2563eb",       // Primary action color
          600: "#2563eb",           // Alias for consistency
          700: "#1d4ed8",
          800: "#1e40af",
          900: "#1e3a8a",
        },

        // ─── Semantic Colors ────────────────────────────────────────
        success: {
          50: "#f0fdf4",
          100: "#dcfce7",
          200: "#bbf7d0",
          300: "#86efac",
          400: "#4ade80",
          DEFAULT: "#16a34a",
          600: "#15803d",
          700: "#166534",
          900: "#145231",
        },
        danger: {
          50: "#fef2f2",
          100: "#fee2e2",
          200: "#fecaca",
          300: "#fca5a5",
          400: "#f87171",
          DEFAULT: "#dc2626",
          600: "#b91c1c",
          700: "#991b1b",
          900: "#7f1d1d",
        },
        warn: {
          50: "#fffbeb",
          100: "#fef3c7",
          200: "#fde68a",
          300: "#fcd34d",
          400: "#fbbf24",
          DEFAULT: "#d97706",
          600: "#b45309",
          700: "#92400e",
          900: "#78350f",
        },
        info: {
          50: "#ecfdf5",
          100: "#d1fae5",
          200: "#a7f3d0",
          300: "#6ee7b7",
          400: "#2dd4bf",
          DEFAULT: "#0891b2",
          600: "#0369a1",
          700: "#0c4a6e",
        },

        // ─── Neutral / Text Colors (Grayscale) ──────────────────────
        // Apple-style neutral palette
        neutral: {
          50: "#fafafa",
          100: "#f5f5f7",
          150: "#f0f0f3",
          200: "#e5e5ea",
          250: "#d9d9e3",
          300: "#d0d0d5",
          400: "#c7c7cc",
          500: "#a1a1a6",
          600: "#8e8e93",       // Secondary text
          700: "#6c6c70",       // Tertiary text
          800: "#545458",
          900: "#424245",       // Primary text (light mode)
          950: "#1d1d1f",       // Primary text (alternative)
        },

        // ─── Primary Text Colors ────────────────────────────────────
        primary: {
          DEFAULT: "#1d1d1f",   // Primary text (Apple black)
          50: "#fafafa",
          100: "#f5f5f7",
          500: "#a1a1a6",
          600: "#8e8e93",
          700: "#6c6c70",
          900: "#1d1d1f",
        },

        // ─── Muted/Secondary Text (for backward compatibility) ──────
        muted: {
          50: "#fafafa",
          100: "#f5f5f7",
          200: "#e5e5ea",
          300: "#d1d5db",       // Keep for compatibility
          400: "#9ca3af",
          500: "#6b7280",
          600: "#8e8e93",
          700: "#6c6c70",
          800: "#545458",
          900: "#1d1d1f",
        },
      },

      // ─── Typography System (Apple HIG inspired) ─────────────────
      fontFamily: {
        // System font stack inspired by Apple (SF Pro)
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          '"DM Sans"',
          '"Helvetica Neue"',
          'sans-serif',
          '"Apple Color Emoji"',
          '"Segoe UI Emoji"',
        ],
        // Refined monospace (replacing IBM Plex Mono)
        mono: [
          '"SF Mono"',
          '"Monaco"',
          '"Menlo"',
          '"Consolas"',
          '"Courier New"',
          'monospace',
        ],
      },

      // Apple HIG Typography Scale
      fontSize: {
        // Captions & Small Text
        "2xs": ["11px", { lineHeight: "1.2", letterSpacing: "0.3px" }],
        xs: ["12px", { lineHeight: "1.4", letterSpacing: "0.3px" }],
        // Body Text
        sm: ["13px", { lineHeight: "1.5", letterSpacing: "0.3px" }],
        base: ["14px", { lineHeight: "1.5", letterSpacing: "0" }],
        md: ["15px", { lineHeight: "1.6", letterSpacing: "0" }],
        lg: ["16px", { lineHeight: "1.6", letterSpacing: "0" }],
        // Subheadings
        xl: ["17px", { lineHeight: "1.6", letterSpacing: "0" }],
        "2xl": ["19px", { lineHeight: "1.6", letterSpacing: "-0.5px" }],
        // Headlines
        "3xl": ["22px", { lineHeight: "1.5", letterSpacing: "-0.5px" }],
        "4xl": ["28px", { lineHeight: "1.3", letterSpacing: "-1px" }],
        "5xl": ["34px", { lineHeight: "1.2", letterSpacing: "-1px" }],
      },

      // ─── Spacing Grid (4px base) ───────────────────────────────
      spacing: {
        0: "0",
        1: "4px",     // 1 unit
        1.5: "6px",   // 1.5 units
        2: "8px",     // 2 units
        2.5: "10px",  // 2.5 units
        3: "12px",    // 3 units
        3.5: "14px",  // 3.5 units
        4: "16px",    // 4 units
        5: "20px",    // 5 units
        6: "24px",    // 6 units
        7: "28px",    // 7 units
        8: "32px",    // 8 units
        9: "36px",    // 9 units
        10: "40px",   // 10 units
        12: "48px",   // 12 units
        14: "56px",   // 14 units
        16: "64px",   // 16 units
        18: "72px",   // 18 units
        20: "80px",   // 20 units
        24: "96px",   // 24 units
      },

      // ─── Shadows (Apple style - subtle depth) ──────────────────
      boxShadow: {
        // Apple-style shadows: barely-there to subtle
        xs: "0 1px 2px 0 rgb(0 0 0 / 0.02)",
        sm: "0 1px 3px 0 rgb(0 0 0 / 0.04)",
        base: "0 2px 8px 0 rgb(0 0 0 / 0.06)",
        md: "0 4px 12px 0 rgb(0 0 0 / 0.08)",
        lg: "0 12px 24px 0 rgb(0 0 0 / 0.1)",
        xl: "0 20px 40px 0 rgb(0 0 0 / 0.12)",
        // Inner shadows for inset effects
        "inner-xs": "inset 0 1px 2px 0 rgb(0 0 0 / 0.02)",
        "inner-sm": "inset 0 1px 3px 0 rgb(0 0 0 / 0.04)",
        // Focus ring (not a shadow, but related)
        focus: "0 0 0 3px rgb(37 99 235 / 0.1)",
      },

      // ─── Border Radius (refined, Apple style) ──────────────────
      borderRadius: {
        sm: "4px",        // Buttons, small components
        DEFAULT: "6px",   // Default (most common)
        md: "8px",        // Medium components
        lg: "12px",       // Large components
        xl: "16px",       // Very large components
        "2xl": "20px",    // Modals, drawers
        "3xl": "28px",    // Soft/pillow effect
        full: "9999px",   // Fully rounded
      },

      // ─── Transitions (Apple style - smooth, natural) ────────────
      transitionDuration: {
        100: "100ms",
        150: "150ms",
        200: "200ms",
        300: "300ms",
      },
      transitionTimingFunction: {
        // Apple standard easing
        "ease-smooth": "cubic-bezier(0.4, 0, 0.2, 1)",
        "ease-snappy": "cubic-bezier(0.25, 0.46, 0.45, 0.94)",
        "ease-natural": "cubic-bezier(0.34, 1.56, 0.64, 1)",
      },

      // ─── Z-Index Scale ────────────────────────────────────────
      zIndex: {
        dropdown: "10",
        sticky: "20",
        sidebar: "30",
        overlay: "40",
        modal: "50",
        toast: "60",
      },

      // ─── Animations ───────────────────────────────────────────
      keyframes: {
        // Subtle, natural animations
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "fade-in-up": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in-right": {
          from: { opacity: "0", transform: "translateX(8px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        "scale-in": {
          from: { opacity: "0", transform: "scale(0.98)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.15s ease-smooth",
        "fade-in-up": "fade-in-up 0.2s ease-smooth",
        "slide-in-right": "slide-in-right 0.15s ease-smooth",
        "scale-in": "scale-in 0.15s ease-smooth",
        shimmer: "shimmer 2s infinite",
      },

      // ─── Max Width for containers ────────────────────────────
      maxWidth: {
        "screen-2xl": "1440px",
      },
    },
  },
  plugins: [],
};
