import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { X, CheckCircle, AlertTriangle, Info } from "lucide-react";
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
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const icons = {
    success: <CheckCircle size={16} className="text-success" />,
    error: <AlertTriangle size={16} className="text-danger" />,
    warn: <AlertTriangle size={16} className="text-warn" />,
    info: <Info size={16} className="text-accent" />,
  };

  return (
    <div
      className={clsx(
        "flex items-start gap-3 bg-bg-card border rounded-lg px-4 py-3 shadow-xl animate-slide-in",
        {
          "border-success/30": toast.type === "success",
          "border-danger/30": toast.type === "error",
          "border-warn/30": toast.type === "warn",
          "border-accent/30": toast.type === "info",
        }
      )}
    >
      {icons[toast.type]}
      <p className="text-primary text-sm flex-1">{toast.message}</p>
      <button onClick={onDismiss} className="text-muted hover:text-primary ml-1">
        <X size={14} />
      </button>
    </div>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
