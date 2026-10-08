import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { resolvePnpmDir } from "./shared.js";

it("uses the managed installer even when system pnpm is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "vgent-managed-pnpm-"));
  try {
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin/pnpm"), "#!/bin/sh\n", { mode: 0o755 });
    vi.stubEnv("PATH", "/nonexistent");
    vi.stubEnv("VGENT_PNPM_DIR", join(root, "bin"));
    expect(resolvePnpmDir()).toBe(join(root, "bin"));
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
