import { useUIStore } from "../store/uiStore";
import clsx from "clsx";

export function UnitToggle() {
  const { unitMode, toggleUnitMode } = useUIStore();

  return (
    <button
      onClick={toggleUnitMode}
      className="flex items-center gap-1 bg-bg-border rounded-lg p-1 text-xs font-mono"
      title="Toggle unit mode"
    >
      <span
        className={clsx(
          "px-2 py-1 rounded transition",
          unitMode === "BASE" ? "bg-accent text-white" : "text-muted hover:text-primary"
        )}
      >
        BASE
      </span>
      <span
        className={clsx(
          "px-2 py-1 rounded transition",
          unitMode === "PKG" ? "bg-accent text-white" : "text-muted hover:text-primary"
        )}
      >
        PKG
      </span>
    </button>
  );
}
