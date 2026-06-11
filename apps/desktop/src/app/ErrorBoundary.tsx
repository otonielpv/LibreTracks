import { Component, type ErrorInfo, type ReactNode } from "react";
import { appendFrontendError } from "@libretracks/shared/desktopApi";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// Top-level safety net. A render-time exception (e.g. an unsupported runtime API
// on an old WebKit) otherwise unmounts the whole React tree, leaving the user a
// blank window with no clue. This catches it, logs it to the backend error log
// (logs/errors.log), and shows the message so a failure is reportable instead of
// silent. It is intentionally minimal and dependency-free so it renders even when
// the rest of the app cannot.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    void appendFrontendError(
      `react render crash: ${error.message}\n${error.stack ?? ""}\n` +
        `componentStack:${info.componentStack ?? ""}`,
    );
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }
    return (
      <div
        style={{
          padding: "24px",
          fontFamily: "system-ui, -apple-system, sans-serif",
          color: "#e5e7eb",
          background: "#111827",
          minHeight: "100vh",
          boxSizing: "border-box",
        }}
      >
        <h1 style={{ fontSize: "18px", marginBottom: "8px" }}>
          LibreTracks hit an unexpected error
        </h1>
        <p style={{ fontSize: "14px", opacity: 0.8, marginBottom: "16px" }}>
          The error was saved to the log. Restart the app; if it keeps happening,
          please report it with your error log.
        </p>
        <pre
          style={{
            fontSize: "12px",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            background: "#0b1220",
            border: "1px solid #1f2937",
            borderRadius: "6px",
            padding: "12px",
            maxHeight: "40vh",
            overflow: "auto",
          }}
        >
          {error.message}
          {"\n"}
          {error.stack}
        </pre>
      </div>
    );
  }
}
