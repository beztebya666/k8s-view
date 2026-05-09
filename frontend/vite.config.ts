import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

const apiTarget = process.env.K8SVIEW_API ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/monaco-editor/") || id.includes("@monaco-editor")) {
            return "monaco";
          }
          if (id.includes("@xterm")) {
            return "xterm";
          }
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
