import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const serverUrl = process.env.VGENT_SERVER_URL ?? "http://127.0.0.1:7412";

/** `<commit count>.<short sha>[+dirty]`, e.g. `45.260aac7` / `45.260aac7+`. Falls back to "dev" outside a git checkout. */
function getBuildId(): string {
  try {
    const opts = { cwd: import.meta.dirname, stdio: ["ignore", "pipe", "ignore"] } as const;
    const count = execSync("git rev-list --count HEAD", opts).toString().trim();
    const sha = execSync("git rev-parse --short HEAD", opts).toString().trim();
    const dirty = execSync("git status --porcelain", opts).toString().trim().length > 0;
    return `${count}.${sha}${dirty ? "+" : ""}`;
  } catch {
    return "dev";
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __VGENT_BUILD__: JSON.stringify(getBuildId()),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
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
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.mjs"],
  },
});
