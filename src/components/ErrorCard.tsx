import { AlertTriangle } from "lucide-react";
import clsx from "clsx";

interface ErrorCardProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  className?: string;
}

export function ErrorCard({ title = "Error", message, onRetry, className }: ErrorCardProps) {
  return (
    <div className={clsx("bento-card border-danger/20 flex flex-col items-center text-center py-8 px-4", className)}>
      <div className="w-10 h-10 rounded-xl bg-danger/10 flex items-center justify-center mb-3">
        <AlertTriangle size={20} className="text-danger" />
      </div>
      <h3 className="text-sm font-semibold text-primary mb-1">{title}</h3>
      <p className="text-xs text-muted mb-4 max-w-xs">{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="btn-secondary btn-sm">
          Try Again
        </button>
      )}
    </div>
  );
}
