import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { ModalsProvider } from "./components/Modals";
import "./styles.css";

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      // We don't refetch on focus because the WebSocket is the source of truth.
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 30_000,
    },
  },
});

// Catch-all error boundary so a render-time throw renders an actionable
// message instead of the previous "pure black screen" symptom. We stick a
// reload button on it so the user can recover without DevTools, and dump
// the error + component stack to the console for any deeper debugging.
class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("k8s-view crashed during render:", error, info);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "#0b0d10",
        color: "#e6e6e6",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        padding: 24,
      }}>
        <div style={{ maxWidth: 720, width: "100%" }}>
          <div style={{ fontSize: 13, opacity: 0.5, marginBottom: 8 }}>k8s-view</div>
          <div style={{ fontSize: 22, marginBottom: 12, fontWeight: 500 }}>
            Something went wrong rendering the page
          </div>
          <pre style={{
            whiteSpace: "pre-wrap",
            background: "#161922",
            border: "1px solid #262930",
            borderRadius: 6,
            padding: 12,
            fontSize: 12,
            color: "#ef9a9a",
            overflow: "auto",
            maxHeight: 320,
          }}>
            {String(this.state.error?.stack ?? this.state.error?.message ?? this.state.error)}
          </pre>
          <button
            onClick={() => { this.setState({ error: null }); window.location.reload(); }}
            style={{
              marginTop: 12,
              padding: "8px 14px",
              background: "#1a1d24",
              border: "1px solid #2a2e36",
              borderRadius: 6,
              color: "#e6e6e6",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <ModalsProvider>
          <AppErrorBoundary>
            <App />
          </AppErrorBoundary>
        </ModalsProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
