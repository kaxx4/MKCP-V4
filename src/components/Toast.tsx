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
      <div className="fixed bottom-4 right-4 z-toast flex max-w-sm flex-col gap-2" role="region" aria-label="Notifications">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const TOAST_STYLES = {
  success: { bg: "bg-success-soft", icon: CheckCircle, iconColor: "text-success-700" },
  error: { bg: "bg-danger-soft", icon: XCircle, iconColor: "text-danger-700" },
  warn: { bg: "bg-warn-soft", icon: AlertTriangle, iconColor: "text-warn-700" },
  info: { bg: "bg-accent-soft", icon: Info, iconColor: "text-accent-700" },
} as const;

/* A toast: 20 px card corner, 8 px in, so the dismiss button's own corner is 12 and round. */
function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const style = TOAST_STYLES[toast.type];
  const Icon = style.icon;

  return (
    <div
      className={clsx("flex items-center gap-3 rounded-lg py-2 pl-4 pr-2 shadow-modal animate-slide-in", style.bg)}
      role="alert"
    >
      <Icon size={16} className={clsx("shrink-0", style.iconColor)} />
      <p className="flex-1 py-1 text-sm text-neutral-950">{toast.message}</p>
      <button
        onClick={onDismiss}
        className="btn-icon shrink-0"
        aria-label="Dismiss notification"
      >
        <X size={16} />
      </button>
    </div>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
