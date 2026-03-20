import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { X, CheckCircle, AlertTriangle, Info, XCircle } from "lucide-react";
import clsx from "clsx";

interface Toast {
  id: string;
  message: string;
  type: "success" | "error" | "info" | "warn";
}

interface ToastContextValue {
  toast: (message: string, type?: Toast["type"]) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((message: string, type: Toast["type"] = "info") => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm" role="region" aria-label="Notifications">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const TOAST_STYLES = {
  success: { border: "border-success/25 dark:border-success/20", bg: "bg-success/[0.04] dark:bg-success/[0.08]", icon: CheckCircle, iconColor: "text-success-600 dark:text-success-400" },
  error: { border: "border-danger/25 dark:border-danger/20", bg: "bg-danger/[0.04] dark:bg-danger/[0.08]", icon: XCircle, iconColor: "text-danger-600 dark:text-danger-400" },
  warn: { border: "border-warn/25 dark:border-warn/20", bg: "bg-warn/[0.04] dark:bg-warn/[0.08]", icon: AlertTriangle, iconColor: "text-warn-600 dark:text-warn-400" },
  info: { border: "border-accent/25 dark:border-accent/20", bg: "bg-accent/[0.04] dark:bg-accent/[0.08]", icon: Info, iconColor: "text-accent dark:text-accent" },
} as const;

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const style = TOAST_STYLES[toast.type];
  const Icon = style.icon;

  return (
    <div
      className={clsx(
        "flex items-start gap-2.5 bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-lg px-4 py-3 shadow-lg animate-slide-in",
        style.border
      )}
      role="alert"
    >
      <Icon size={16} className={clsx("flex-shrink-0 mt-0.5", style.iconColor)} />
      <p className="text-neutral-950 dark:text-neutral-100 text-sm flex-1 leading-snug">{toast.message}</p>
      <button
        onClick={onDismiss}
        className="text-neutral-500 dark:text-neutral-500 hover:text-neutral-950 dark:hover:text-neutral-100 transition-colors flex-shrink-0 -mr-1"
        aria-label="Dismiss notification"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
