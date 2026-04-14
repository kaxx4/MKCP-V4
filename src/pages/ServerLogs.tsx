import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal, Trash2, Copy, CheckCheck, RefreshCw, Circle } from "lucide-react";

// tallyApi.ts uses this same base — must match so Electron file:// loads work
const BASE = (import.meta as any).env?.VITE_TALLY_PROXY || "http://localhost:3100";

type LogLine = {
  text: string;
  level: "success" | "error" | "warn" | "info";
};

function classify(line: string): LogLine["level"] {
  if (line.includes("✓") || line.includes("ready") || line.includes("success") || line.includes("✅"))
    return "success";
  if (line.includes("❌") || line.includes("✗") || line.includes("error") || line.includes("Error") || line.includes("failed") || line.includes("Failed"))
    return "error";
  if (line.includes("⚠") || line.includes("warn") || line.includes("Warn") || line.includes("timeout") || line.includes("retry"))
    return "warn";
  return "info";
}

export default function ServerLogs() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [connected, setConnected] = useState(false);
  const [copied, setCopied] = useState(false);
  const [filterLevel, setFilterLevel] = useState<"all" | "error" | "warn">("all");
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  const addLines = useCallback((raw: string[]) => {
    setLines((prev) => {
      const next = [
        ...prev,
        ...raw.map((t) => ({ text: t, level: classify(t) })),
      ];
      return next.slice(-2000); // cap at 2000 lines in UI
    });
  }, []);

  // Initial load + SSE stream
  const connect = useCallback(() => {
    // Load existing buffer
    fetch(`${BASE}/api/tally/logs`)
      .then((r) => r.json())
      .then((data: string[]) => {
        setLines(data.map((t) => ({ text: t, level: classify(t) })));
        setConnected(true);
      })
      .catch(() => setConnected(false));

    // Subscribe to new lines via SSE
    if (esRef.current) esRef.current.close();
    const es = new EventSource(`${BASE}/api/tally/progress`);
    esRef.current = es;

    es.onopen = () => setConnected(true);
    es.onmessage = (e) => {
      try {
        const text: string = JSON.parse(e.data);
        addLines([text]);
      } catch {}
    };
    es.onerror = () => {
      setConnected(false);
      // SSE auto-reconnects — don't close it
    };
  }, [addLines]);

  useEffect(() => {
    connect();
    return () => esRef.current?.close();
  }, [connect]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines, autoScroll]);

  // Detect manual scroll up → disable auto-scroll
  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 60;
    setAutoScroll(atBottom);
  };

  const clear = () => setLines([]);

  const copyAll = () => {
    const text = lines.map((l) => l.text).join("\n");
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const filtered = filterLevel === "all"
    ? lines
    : lines.filter((l) => l.level === filterLevel);

  const errorCount = lines.filter((l) => l.level === "error").length;
  const warnCount = lines.filter((l) => l.level === "warn").length;

  return (
    <div className="flex flex-col h-full bg-neutral-950 text-neutral-100 font-mono">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800 bg-neutral-900 shrink-0">
        <div className="flex items-center gap-3">
          <Terminal size={18} className="text-neutral-400" />
          <span className="text-sm font-semibold text-neutral-200">Server Logs</span>
          {/* Connection indicator */}
          <span className="flex items-center gap-1.5 text-xs">
            <Circle
              size={7}
              className={connected ? "fill-emerald-400 text-emerald-400" : "fill-red-500 text-red-500"}
            />
            <span className={connected ? "text-emerald-400" : "text-red-400"}>
              {connected ? "connected" : "disconnected"}
            </span>
          </span>
        </div>

        {/* Filters + actions */}
        <div className="flex items-center gap-2">
          {/* Filter pills */}
          <button
            onClick={() => setFilterLevel("all")}
            className={`px-2.5 py-0.5 rounded text-xs ${filterLevel === "all" ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-white"}`}
          >
            All ({lines.length})
          </button>
          <button
            onClick={() => setFilterLevel("error")}
            className={`px-2.5 py-0.5 rounded text-xs ${filterLevel === "error" ? "bg-red-900 text-red-300" : "text-red-500 hover:text-red-300"}`}
          >
            Errors ({errorCount})
          </button>
          <button
            onClick={() => setFilterLevel("warn")}
            className={`px-2.5 py-0.5 rounded text-xs ${filterLevel === "warn" ? "bg-yellow-900 text-yellow-300" : "text-yellow-500 hover:text-yellow-300"}`}
          >
            Warn ({warnCount})
          </button>

          <div className="w-px h-4 bg-neutral-700 mx-1" />

          <button
            onClick={connect}
            title="Reconnect"
            className="p-1.5 rounded hover:bg-neutral-700 text-neutral-400 hover:text-white transition-colors"
          >
            <RefreshCw size={14} />
          </button>
          <button
            onClick={copyAll}
            title="Copy all"
            className="p-1.5 rounded hover:bg-neutral-700 text-neutral-400 hover:text-white transition-colors"
          >
            {copied ? <CheckCheck size={14} className="text-emerald-400" /> : <Copy size={14} />}
          </button>
          <button
            onClick={clear}
            title="Clear"
            className="p-1.5 rounded hover:bg-neutral-700 text-neutral-400 hover:text-red-400 transition-colors"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* Log body */}
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-4 py-3 space-y-0.5 text-xs leading-5"
      >
        {filtered.length === 0 ? (
          <div className="text-neutral-600 mt-8 text-center">No log entries yet.</div>
        ) : (
          filtered.map((l, i) => (
            <div
              key={i}
              className={`whitespace-pre-wrap break-all ${
                l.level === "success" ? "text-emerald-400" :
                l.level === "error"   ? "text-red-400" :
                l.level === "warn"    ? "text-yellow-400" :
                "text-neutral-300"
              }`}
            >
              {l.text}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Footer: auto-scroll indicator */}
      {!autoScroll && (
        <div className="shrink-0 flex justify-center py-2 border-t border-neutral-800">
          <button
            onClick={() => { setAutoScroll(true); bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }}
            className="text-xs text-neutral-400 hover:text-white bg-neutral-800 hover:bg-neutral-700 px-3 py-1 rounded-full transition-colors"
          >
            ↓ scroll to latest
          </button>
        </div>
      )}
    </div>
  );
}
