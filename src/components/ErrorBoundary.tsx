import { Component, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error("ErrorBoundary caught:", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-bg flex items-center justify-center p-6">
          <div className="bg-white border border-danger/20 rounded-2xl p-8 max-w-md w-full text-center shadow-base">
            <div className="w-14 h-14 rounded-2xl bg-danger/10 flex items-center justify-center mx-auto mb-5">
              <AlertTriangle size={28} className="text-danger" />
            </div>
            <h2 className="text-xl font-bold text-primary mb-2">Something went wrong</h2>
            <p className="text-muted text-sm mb-6 font-mono bg-bg-hover/50 rounded-lg px-3 py-2 text-left break-all">
              {this.state.error?.message ?? "An unexpected error occurred"}
            </p>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.href = "/";
              }}
              className="btn-primary btn-lg gap-2"
            >
              <RotateCcw size={16} />
              Reset App
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
