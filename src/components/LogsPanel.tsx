/*
 * Logs, rebuilt from 0 on the web dashboard's idiom.
 *
 * ── What was wrong with the old one ───────────────────────────────────────
 *
 * It was a black terminal — `bg-neutral-950 text-neutral-200` — dropped into a
 * light app, with its own private colour scheme: `text-red-400` for errors,
 * `text-green-400`, `text-amber-400`, `text-cyan-300`, `text-violet-300`. Five
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
 * And the error count was buried in the collapsed header, in `text-red-600`,
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
  ["supabase", "Supabase"],
  ["remote", "Web-triggered"],
  ["auto", "Scheduled"],
];

/* Genuine failures carry the ❌/✗ marker the server prefixes every
   console.error with. The word test also catches plain-text failures, but must
   not catch a benign "(0 errors)" summary. */
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
    <div className="space-y-2.5">
      {/* 1 — what needs a person */}
      {errorCount > 0 && filter !== "errors" && (
        <div className="flex items-start gap-2 rounded-xl bg-danger-soft px-3 py-2.5 text-[12px] text-danger-700">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">
              {errorCount} error line{errorCount === 1 ? "" : "s"} in the buffer.
            </p>
            <p className="mt-0.5">
              This is a rolling tail of the last {logs.length} lines, so an error that scrolled off is gone — copy it
              before restarting anything.
            </p>
          </div>
          <button onClick={() => setFilter("errors")} className="btn-secondary btn-sm shrink-0">
            Show only these
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            aria-pressed={filter === key}
            className={clsx("filter-chip text-[11px]", filter === key && "filter-chip-active")}
          >
            {label}
            {key === "errors" && errorCount > 0 && <span className="tabular-nums">({errorCount})</span>}
          </button>
        ))}
        {/* Its own control, not a span nested inside the section's button. */}
        <button onClick={() => onCopy(visible.join("\n"))} className="btn-secondary btn-sm ml-auto">
          <ClipboardCopy size={12} />
          Copy {filter === "all" ? "all" : "these"}
        </button>
      </div>

      <div
        ref={boxRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="h-80 overflow-y-auto rounded-xl bg-white p-3 font-mono text-[11px] leading-relaxed ring-1 ring-black/[0.06]"
      >
        {visible.length === 0 ? (
          <span className="font-sans text-[12.5px] text-neutral-500">
            {logs.length === 0
              ? "Nothing yet — the server writes here as it works. Run a sync and lines appear."
              : `No ${filter === "all" ? "" : FILTERS.find(([k]) => k === filter)?.[1].toLowerCase() + " "}lines in the current buffer.`}
          </span>
        ) : (
          visible.map((line, i) => (
            <div
              key={i}
              className={clsx(
                "whitespace-pre-wrap break-words",
                /* The same tokens as everywhere else. "Failed" is one red. */
                isErrorLine(line) ? "text-danger-700"
                : /⚠/.test(line) ? "text-warn-800"
                : /✓/.test(line) ? "text-success-700"
                : /🌐|🌙/.test(line) ? "text-accent-700"
                : "text-neutral-700",
              )}
            >
              {line}
            </div>
          ))
        )}
      </div>

      <p className="flex items-start gap-1.5 text-[11px] text-neutral-500">
        <Terminal size={11} className="mt-0.5 shrink-0" />
        Live tail of this app's server — {logs.length} line{logs.length === 1 ? "" : "s"} held, refreshed every 2s.
        The same tail is served as a page at <span className="font-mono">{base}/</span>, which survives this window
        being closed.
      </p>
    </div>
  );
}

export default LogsPanel;
