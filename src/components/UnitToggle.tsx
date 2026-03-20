import { useUIStore } from "../store/uiStore";
import clsx from "clsx";

export function UnitToggle() {
  const { unitMode, toggleUnitMode } = useUIStore();

  return (
    <button
      onClick={toggleUnitMode}
      className="inline-flex items-center bg-bg-hover rounded-lg p-0.5 text-xs font-mono"
      title="Toggle unit mode"
      aria-label={`Unit mode: ${unitMode}. Click to toggle.`}
    >
      <span
        className={clsx(
          "px-2 py-1 rounded-md transition-all duration-150",
          unitMode === "BASE" ? "bg-accent text-white shadow-xs font-medium" : "text-muted hover:text-primary"
        )}
      >
        BASE
      </span>
      <span
        className={clsx(
          "px-2 py-1 rounded-md transition-all duration-150",
          unitMode === "PKG" ? "bg-accent text-white shadow-xs font-medium" : "text-muted hover:text-primary"
        )}
      >
        PKG
      </span>
    </button>
  );
}
