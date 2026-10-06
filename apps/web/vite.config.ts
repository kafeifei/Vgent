import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const serverUrl = process.env.VGENT_SERVER_URL ?? "http://127.0.0.1:7412";

/** Product version comes from the desktop config; build number is an independent counter. */
function getBuildInfo(): { version: string; number: number; sha: string; dirty: boolean } {
  const configPath = fileURLToPath(new URL("../desktop/src-tauri/tauri.conf.json", import.meta.url));
  const { version } = JSON.parse(readFileSync(configPath, "utf8")) as { version: string };
  let number = 0;
  try {
    const buildNumberPath = fileURLToPath(new URL("../desktop/build-number", import.meta.url));
    number = Number.parseInt(readFileSync(buildNumberPath, "utf8").trim(), 10) || 0;
  } catch {
    number = 0;
  }

  let sha = "dev";
  let dirty = false;
  try {
    const opts = { cwd: import.meta.dirname, stdio: ["ignore", "pipe", "ignore"] } as const;
    sha = execSync("git rev-parse --short HEAD", opts).toString().trim();
    dirty = execSync("git status --porcelain", opts).toString().trim().length > 0;
  } catch {
    sha = "dev";
    dirty = false;
  }

  return { version, number, sha, dirty };
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __VGENT_BUILD__: JSON.stringify(getBuildInfo()),
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
