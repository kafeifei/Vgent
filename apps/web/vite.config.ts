import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const serverUrl = process.env.VGENT_SERVER_URL ?? "http://127.0.0.1:7412";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: serverUrl,
        changeOrigin: false,
      },
    },
  },
  test: {
    passWithNoTests: true,
  },
});
