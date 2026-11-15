const path = require("node:path");

/* Content globs are ABSOLUTE, resolved against this config file.

   Tailwind resolves a relative `content` glob against process.cwd(), not against the config. Any tool that starts the dev server from a
   directory other than this one therefore matches ZERO source files and the window renders as unstyled text. Anchoring to __dirname makes
   the scan independent of where the process was launched from. */
const here = (p) => path.join(__dirname, p);

/* Every value below is a NAME from src/styles/tokens.css (the blue design language, copied from the web app). No literal colour, size, radius or
   shadow is written here: change a value in tokens.css and the whole window follows. The old class names (neutral-500, accent-700, danger-soft...)
   are kept so the panels did not each need a rewrite; they now point at the blue language.

   Colours are variables, so Tailwind's slash-opacity form (bg-accent/10) does not work on them. That is on purpose: a see-through tint is one
   more colour to keep in step, so every tint is its own token (accent-soft, danger-soft...). scripts/test-agent-ui.ts fails on a slash-opacity use. */
const v = (name) => `var(--${name})`;

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [here("index.html"), here("src/**/*.{ts,tsx}")],
  theme: {
    colors: {
      transparent: "transparent",
      current: "currentColor",
      white: v("card"),
      black: v("ink"),
      bg: { DEFAULT: v("card"), page: v("page"), sub: v("soft"), card: v("card"), hover: v("soft"), border: v("line") },
      /* the ink scale: surfaces and lines at the light end, text at the dark end */
      neutral: {
        50: v("soft"), 100: v("soft"), 150: v("soft-2"), 200: v("line"), 250: v("line"), 300: v("line-2"),
        400: v("faint"), 500: v("faint"), 600: v("muted"), 700: v("ink-3"), 800: v("ink-2"), 900: v("text"), 950: v("ink"),
      },
      muted: { DEFAULT: v("muted"), 500: v("faint"), 600: v("muted"), 700: v("ink-3") },
      primary: { DEFAULT: v("text") },
      /* the one accent */
      accent: { DEFAULT: v("b600"), 50: v("b100"), 100: v("b100"), 200: v("b200"), 400: v("b400"), 600: v("b600"), 700: v("b700"), 800: v("b700"), 900: v("b700"), soft: v("b100") },
      info: { DEFAULT: v("b700"), 600: v("b700"), 700: v("b700") },
      /* status colours are for a pill, a figure or an error line and nothing else */
      success: { DEFAULT: v("good"), 50: v("good-bg"), 100: v("good-bg"), 600: v("good"), 700: v("good-ink"), 800: v("good-ink"), soft: v("good-bg") },
      danger: { DEFAULT: v("bad"), 50: v("bad-bg"), 100: v("bad-bg"), 600: v("bad"), 700: v("bad-ink"), 800: v("bad-ink"), soft: v("bad-bg") },
      warn: { DEFAULT: v("warn"), 50: v("warn-bg"), 100: v("warn-bg"), 600: v("warn"), 700: v("warn-ink"), 800: v("warn-ink"), soft: v("warn-bg") },
    },
    fontFamily: {
      sans: [v("font")],
      display: [v("font-display")],
      /* No second family: figures and paths stay in Geist, aligned with tabular numerals (see index.css). */
      mono: [v("font")],
    },
    /* Never bold: the design uses 300, 400 and 500. The old bold classes are kept so no panel breaks, and all land on 500. */
    fontWeight: {
      light: v("fw-light"), normal: v("fw"), medium: v("fw-medium"),
      semibold: v("fw-medium"), bold: v("fw-medium"), extrabold: v("fw-medium"), black: v("fw-medium"),
    },
    /* Eight steps, none under 12 px. */
    fontSize: {
      xs: [v("fs-12"), { lineHeight: v("lh-12") }],
      sm: [v("fs-14"), { lineHeight: v("lh-14") }],
      base: [v("fs-14"), { lineHeight: v("lh-14") }],
      md: [v("fs-16"), { lineHeight: v("lh-16") }],
      lg: [v("fs-16"), { lineHeight: v("lh-16") }],
      xl: [v("fs-18"), { lineHeight: v("lh-18") }],
      "2xl": [v("fs-24"), { lineHeight: v("lh-24"), letterSpacing: v("ls-display") }],
      "3xl": [v("fs-32"), { lineHeight: v("lh-32"), letterSpacing: v("ls-display") }],
      "4xl": [v("fs-40"), { lineHeight: v("lh-40"), letterSpacing: v("ls-display") }],
      "5xl": [v("fs-56"), { lineHeight: v("lh-56"), letterSpacing: v("ls-display") }],
    },
    /* Concentric: an inner corner is its outer corner minus the gap. Card 20, a row tray inside it 12, a tile inside the row 4. */
    borderRadius: {
      none: "0", xs: v("r-xs"), sm: v("r-sm"), DEFAULT: v("r-sm"), md: v("r-md"), lg: v("r-lg"), xl: v("r-xl"), "2xl": v("r-xl"), "3xl": v("r-xl"), full: v("r-pill"),
    },
    boxShadow: {
      none: "none", card: v("shadow-card"), button: v("shadow-button"), menu: v("shadow-menu"), modal: v("shadow-modal"),
    },
    transitionDuration: { DEFAULT: v("dur"), 100: v("dur"), 150: v("dur"), 200: v("dur"), 300: v("dur") },
    transitionTimingFunction: { DEFAULT: v("ease"), "ease-smooth": v("ease") },
    extend: {
      /* Tailwind's own 4 px scale stays (p-2 is 8, p-3 is 12, p-4 is 16, p-6 is 24); half steps are not used. 11 is the 44 px tap target. */
      spacing: { 11: v("tap") },
      minHeight: { tap: v("tap"), 11: v("tap") },
      minWidth: { tap: v("tap") },
      maxWidth: { page: v("page-max"), screen: "100vw" },
      zIndex: { dropdown: "10", sticky: "20", overlay: "40", modal: "50", toast: "60" },
    },
  },
  corePlugins: { ringWidth: true, ringColor: true },
  plugins: [],
};
