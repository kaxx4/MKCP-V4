import { fileURLToPath } from "node:url";

/*
 * The Tailwind config is passed by ABSOLUTE path, not left to discovery.
 *
 * With `tailwindcss: {}`, Tailwind looks for `tailwind.config.js` relative to
 * `process.cwd()`. Any tool that starts the dev server from a directory other
 * than this one — an editor's run-configuration, a task runner, the browser
 * preview launcher — finds no config there, and Tailwind falls back to its
 * DEFAULTS, which have `content: []`.
 *
 * The failure is near-invisible, which is why it survives: preflight and every
 * `@layer components` rule in index.css are emitted regardless of the content
 * scan, so the window still gets its background, its fonts and its `.card` and
 * `.btn-*` classes. Only the utility layer is missing — and this renderer is
 * built almost entirely from utilities, so the whole window renders as one
 * column of unstyled text. Measured here: 32 KB of CSS served with no
 * `.rounded-2xl`, no `.bg-white`, no `.p-4`, while `npm run build` (which does
 * run from this directory) produced a completely correct stylesheet. It reads
 * as a broken stylesheet rather than a config that was never found.
 *
 * The web dashboard hit this first and fixed it the same way; this file had not
 * been given the same treatment. Anchoring to import.meta.url makes the
 * resolution independent of where the process was launched from.
 */
export default {
  plugins: {
    tailwindcss: { config: fileURLToPath(new URL("./tailwind.config.js", import.meta.url)) },
    autoprefixer: {},
  },
};
