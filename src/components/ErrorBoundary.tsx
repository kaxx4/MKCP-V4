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
        <div className="flex min-h-screen items-center justify-center bg-bg-page p-6">
          <div className="w-full max-w-md rounded-lg bg-white p-6 text-center shadow-card">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-md bg-danger-soft">
              <AlertTriangle size={24} className="text-danger-700" />
            </div>
            <h2 className="mb-2 text-xl text-neutral-950">Something went wrong</h2>
            <p className="mb-6 rounded-sm bg-bg-sub px-3 py-2 text-left text-sm text-neutral-700 wrap-anywhere">
              {this.state.error?.message ?? "An unexpected error occurred"}
            </p>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.reload();
              }}
              className="btn-primary"
            >
              <RotateCcw size={16} />
              Reset the window
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
