/*
 * Logs, rebuilt from 0 on the web dashboard's idiom.
 *
 * ── What was wrong with the old one ───────────────────────────────────────
 *
 * It was a black terminal — `bg-neutral-950 text-neutral-200` — dropped into a
 * light app, with its own private colour scheme: `text-danger-700` for errors,
 * `text-success-700`, `text-warn-700`, `text-accent-700`, `text-accent-700`. Five
 * colours that exist nowhere else in either app. A failure line here was a
 * completely different red from the failure three inches above it in the push
 * queue, which is the exact thing the semantic tokens are for. The web
 * dashboard has one dark `<pre>` in the whole codebase and dozens of light
 * ones; this is not the house voice.
 *
 * Its Copy control was a `<span role="button" tabIndex={0}>` nested INSIDE the
 * section's own `<button>`. A button inside a button is invalid, and the
 * browser's own behaviour for it is undefined — the `stopPropagation` was there
 * to paper over a collapse that fired on every copy. Keyboard users got a
 * focusable span that does nothing on Enter, because only `onClick` was bound.
 *
 * Its filter row hand-rolled `bg-neutral-900 text-white border-neutral-900` for
 * the active chip when `.filter-chip` / `.filter-chip-active` already exist in
 * index.css and are what every other segmented control in both apps uses.
 *
 * And the error count was buried in the collapsed header, in `text-danger-700`,
 * where it was visible only once you had already opened the panel to look.
 *
 * ── What this shows instead ───────────────────────────────────────────────
 *
 * The errors first, as a count you can act on in one click, then the tail on
 * the app's own paper with `text-danger-700` doing what it does everywhere
 * else. The tail itself stays monospaced and stays a tail — it is a console,
 * and pretending otherwise would cost the alignment that makes it scannable.
 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { AlertTriangle, ClipboardCopy, Terminal } from "lucide-react";

export type LogFilter = "all" | "errors" | "tally" | "supabase" | "remote" | "auto";

const FILTERS: Array<[LogFilter, string]> = [
  ["all", "All"],
  ["errors", "Errors"],
  ["tally", "Tally"],
  ["supabase", "Online database"],
  ["remote", "Asked from the web"],
  ["auto", "Scheduled"],
];

/* Genuine failures carry the ❌/✗ marker the server prefixes every
   console.error with. The word test also catches plain-text failures, but must
   not catch a benign "(0 errors)" summary. */
/** The server marks its own lines with symbols and pictures. They are read for meaning above and never drawn, because this window shows words only. */
export const plainLine = (l: string): string =>
  l.replace(/[\p{Extended_Pictographic}\uFE0F\u2713\u2717]/gu, "").replace(/ {2,}/g, " ").trim();

export const isErrorLine = (l: string) =>
  /❌|✗/.test(l) || /\bfailed\b|\bexception\b|\brejected\b/i.test(l);

const MATCHERS: Record<Exclude<LogFilter, "all" | "errors">, RegExp> = {
  tally: /\[tally\]|\[DAYBOOK\]|\[SYNC\]|\[MASTERS\]|\[convert\]|\[PUSH-TEST\]/i,
  supabase: /\[Supabase\]|\[pushAgent\]|\[Auto-push|\[Config Sync\]/i,
  remote: /🌐|\[WEB-SYNC\]/,
  auto: /🌙|\[NIGHTLY\]|origin=scheduled-/i,
};

interface Props {
  logs: string[];
  /** Base URL of this app's own server, for the "same tail, in a browser" note. */
  base: string;
  /** Called with the text of what is currently on screen. */
  onCopy: (text: string) => void;
}

export function LogsPanel({ logs, base, onCopy }: Props) {
  const [filter, setFilter] = useState<LogFilter>("all");
  const boxRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  const errorCount = logs.filter(isErrorLine).length;
  const visible = logs.filter((l) => {
    if (filter === "all") return true;
    if (filter === "errors") return isErrorLine(l);
    return MATCHERS[filter].test(l);
  });

  /* Pinned to the bottom unless the reader scrolled up to look at something. */
  useEffect(() => {
    const el = boxRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [logs, filter]);

  return (
    <div className="space-y-4">
      {/* 1 — what needs a person */}
      {errorCount > 0 && filter !== "errors" && (
        <div className="note note-bad">
          <AlertTriangle size={16} className="mt-1 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {errorCount} line{errorCount === 1 ? "" : "s"} below {errorCount === 1 ? "reports" : "report"} an error.
            </p>
            <p className="mt-1">
              Only the last {logs.length} lines are kept, so an error that has scrolled off is gone. Copy it
              before closing or restarting anything.
            </p>
          </div>
          <button onClick={() => setFilter("errors")} className="btn-secondary shrink-0">
            Show only these
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            aria-pressed={filter === key}
            className={clsx("filter-chip", filter === key && "filter-chip-active")}
          >
            {label}
            {key === "errors" && errorCount > 0 && <span className="tabular-nums">({errorCount})</span>}
          </button>
        ))}
        {/* Its own control, not a span nested inside the section's button. */}
        <button onClick={() => onCopy(visible.join("\n"))} className="btn-secondary ml-auto">
          <ClipboardCopy size={16} />
          Copy {filter === "all" ? "all" : "these"}
        </button>
      </div>

      <div
        ref={boxRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="tray h-80 overflow-y-auto font-mono text-xs"
      >
        {visible.length === 0 ? (
          <span className="font-sans text-sm text-neutral-700">
            {logs.length === 0
              ? "Nothing yet. This app writes here as it works. Run a sync and lines will appear."
              : `No ${filter === "all" ? "" : FILTERS.find(([k]) => k === filter)?.[1].toLowerCase() + " "}lines are held right now.`}
          </span>
        ) : (
          visible.map((line, i) => (
            <div
              key={i}
              className={clsx(
                "whitespace-pre-wrap wrap-anywhere",
                /* The same tokens as everywhere else. "Failed" is one red. */
                isErrorLine(line) ? "text-danger-700"
                : /⚠/.test(line) ? "text-warn-700"
                : /✓/.test(line) ? "text-success-700"
                : /🌐|🌙/.test(line) ? "text-accent-700"
                : "text-neutral-700",
              )}
            >
              {plainLine(line)}
            </div>
          ))
        )}
      </div>

      <p className="flex items-start gap-2 text-xs text-neutral-700">
        <Terminal size={16} className="mt-1 shrink-0" />
        The latest lines from this app's server: {logs.length} line{logs.length === 1 ? "" : "s"} held, refreshed every 2 seconds.
        The same lines are also shown as a web page at {base}/, which stays available when this window is closed.
      </p>
    </div>
  );
}

export default LogsPanel;
