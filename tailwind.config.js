const path = require("node:path");

/* Content globs are ABSOLUTE, resolved against this config file.

   Tailwind resolves a relative `content` glob against process.cwd(), not
   against the config. Any tool that starts the dev server from a directory
   other than this one therefore matches ZERO source files, and Tailwind emits a
   stylesheet with preflight and the @layer components rules — neither of which
   depends on the content scan — but not one utility class. The window then
   renders as a single column of unstyled text, which reads as a broken
   stylesheet rather than a scan that found nothing, and production is
   unaffected, which is what lets it survive.

   The web dashboard hit this and fixed it the same way; this config had not
   been given the same treatment. Anchoring to __dirname makes the scan
   independent of where the process was launched from. */
const here = (p) => path.join(__dirname, p);

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [here("index.html"), here("src/**/*.{ts,tsx}")],
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

          /* The three surface tiers the web dashboard defines, added here on
             15-Sep-2026 because this repo was USING two of them without
             owning them: `bg-bg-page` (AgentStatus.tsx) and `bg-bg-sub`
             (StatusRow.tsx, StatTile.tsx) had no entry in this scale, so
             Tailwind emitted no such utility. They rendered correctly only
             because theme-bento.css happens to carry a plain
             `[data-theme="bento"] .bg-bg-page` rule — i.e. the ground of
             every panel on this screen depended on a theme layer that
             main.tsx could stop applying without anything failing loudly.
             Defining them here makes the base stylesheet correct on its own;
             the bento layer still wins on specificity and repaints them. */
          card: "#ffffff",
          page: "#eeefec",
          sub: "#f6f6f4",
        },

        // ─── Primary Accent (Blue) ──────────────────────────────────
        // Kept as specified by user (#2563eb)
        /* Same palette as the web dashboard (MKCP MOB2/web-dashboard). The two
           apps sit side by side on the same desk, opened by the same person,
           showing the same books — and were running different design systems:
           this one on the older "Bold Financial" scheme (IBM Plex Sans, accent
           #2563eb), the web app on "Refined Minimal" (Plus Jakarta Sans, accent
           #2f5fe0). The class vocabulary was already shared, so only the tokens
           had drifted; they are matched here rather than the components being
           rewritten. */
        accent: {
          50: "#f0f9ff",
          100: "#e0f2fe",
          200: "#bae6fd",
          300: "#7dd3fc",
          400: "#38bdf8",
          DEFAULT: "#2f5fe0",
          600: "#2f5fe0",
          700: "#1d4ed8",
          800: "#1e40af",
          900: "#1e3a8a",
          /* Explicit tint token rather than an opacity trick, so a badge on a
             card reads the same as one on the page ground. */
          soft: "#eaf0fd",
        },

        // ─── Semantic Colors ────────────────────────────────────────
        success: {
          50: "#f0fdf4",
          100: "#dcfce7",
          200: "#bbf7d0",
          300: "#86efac",
          400: "#4ade80",
          500: "#22c55e",
          DEFAULT: "#16a34a",
          600: "#15803d",
          700: "#166534",
          900: "#145231",
          /* Flat tint for a "good" strip — matches the web dashboard. */
          soft: "#e7f6ee",
        },
        danger: {
          50: "#fef2f2",
          100: "#fee2e2",
          200: "#fecaca",
          300: "#fca5a5",
          400: "#f87171",
          500: "#ef4444",
          DEFAULT: "#dc2626",
          600: "#b91c1c",
          700: "#991b1b",
          800: "#8a1a1a",
          900: "#7f1d1d",
          /* Flat tint for a "problem" strip — matches the web dashboard. */
          soft: "#fbeaea",
        },
        warn: {
          50: "#fffbeb",
          100: "#fef3c7",
          200: "#fde68a",
          300: "#fcd34d",
          400: "#fbbf24",
          500: "#f59e0b",
          DEFAULT: "#d97706",
          600: "#b45309",
          700: "#92400e",
          800: "#7c3d0f",
          900: "#78350f",
          /* Flat tint for a "warning" strip — matches the web dashboard. */
          soft: "#fdf4e6",
        },
        // info: aligned to the web repo's blue ramp. Was a teal/cyan/green ramp
        // (DEFAULT #0891b2) that read as a second "success"; the web already
        // fixed this to blue. Kept in sync so badge-info/alert-info render the
        // same colour in both apps. See AUDIT_DESIGN_CONSISTENCY.md M-8.
        info: {
          50: "#eff6ff",
          100: "#dbeafe",
          200: "#bfdbfe",
          300: "#93c5fd",
          400: "#60a5fa",
          DEFAULT: "#1d4ed8",
          600: "#1e40af",
          700: "#1e3a8a",
        },

        // ─── Neutral / Text Colors (Grayscale) ──────────────────────
        // Apple-style neutral palette
        neutral: {
          50: "#fafafa",
          100: "#f5f5f7",
          150: "#f0f0f3",
          200: "#e7e7e3",
          250: "#d9d9e3",
          300: "#d0d0d5",
          400: "#c7c7cc",
          500: "#9a9aa0",
          600: "#8e8e93",       // Secondary text
          700: "#6b6b70",       // Tertiary text
          800: "#545458",
          900: "#424245",       // Primary text (light mode)
          950: "#16161a",       // Primary text (alternative)
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

      // ─── Typography System (IBM Plex - Bold Financial Dashboard) ──
      fontFamily: {
        sans: [
          '"Plus Jakarta Sans"',
          '"IBM Plex Sans"',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
          '"Apple Color Emoji"',
          '"Segoe UI Emoji"',
        ],
        mono: [
          '"IBM Plex Mono"',
          '"SF Mono"',
          '"Cascadia Code"',
          '"Consolas"',
          '"Menlo"',
          'monospace',
        ],
      },

      // Clean type scale — legible sizes, tighter headlines
      fontSize: {
        "2xs": ["11px", { lineHeight: "16px" }],
        xs:    ["12px", { lineHeight: "16px" }],
        sm:    ["13px", { lineHeight: "20px" }],
        base:  ["14px", { lineHeight: "20px" }],
        md:    ["15px", { lineHeight: "22px" }],
        lg:    ["16px", { lineHeight: "24px" }],
        xl:    ["18px", { lineHeight: "26px" }],
        "2xl": ["20px", { lineHeight: "28px", letterSpacing: "-0.02em" }],
        "3xl": ["24px", { lineHeight: "32px", letterSpacing: "-0.02em" }],
        "4xl": ["30px", { lineHeight: "36px", letterSpacing: "-0.025em" }],
        "5xl": ["36px", { lineHeight: "40px", letterSpacing: "-0.025em" }],
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
