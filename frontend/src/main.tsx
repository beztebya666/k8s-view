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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <ModalsProvider>
          <App />
        </ModalsProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
