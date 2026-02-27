import { Component, type ReactNode } from "react";

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
        <div className="min-h-screen bg-bg flex items-center justify-center p-8">
          <div className="bg-bg-card border border-danger/30 rounded-xl p-8 max-w-lg w-full text-center">
            <div className="text-5xl mb-4">⚠️</div>
            <h2 className="text-xl font-bold text-primary mb-2">Something went wrong</h2>
            <p className="text-muted text-sm mb-4 font-mono">
              {this.state.error?.message ?? "An unexpected error occurred"}
            </p>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.href = "/";
              }}
              className="bg-accent hover:bg-accent-hover text-white font-semibold px-6 py-2 rounded-lg transition"
            >
              Reset App
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
