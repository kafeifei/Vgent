import { mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { prepareCodexHome } from "./codex.js";

let root: string;
let userHome: string;
let dataDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vgent-codex-home-"));
  userHome = join(root, "codex");
  dataDir = join(root, "data");
  await mkdir(userHome, { recursive: true });
});

describe("prepareCodexHome", () => {
  it("links the user's global AGENTS.md into the private home", async () => {
    await writeFile(join(userHome, "AGENTS.md"), "始终用中文回复。");
    const home = await prepareCodexHome(dataDir, { CODEX_HOME: userHome });

    expect(home).toBe(join(dataDir, "codex-home"));
    expect(await readlink(join(home, "AGENTS.md"))).toBe(join(userHome, "AGENTS.md"));
    await writeFile(join(userHome, "AGENTS.md"), "改过了");
    expect(await readFile(join(home, "AGENTS.md"), "utf8")).toBe("改过了");
  });

  it("drops the link once the user has no global AGENTS.md", async () => {
    await writeFile(join(userHome, "AGENTS.md"), "rule");
    await prepareCodexHome(dataDir, { CODEX_HOME: userHome });
    await Promise.all([prepareCodexHome(dataDir, { CODEX_HOME: userHome }), prepareCodexHome(dataDir, { CODEX_HOME: userHome })]);

    await rm(join(userHome, "AGENTS.md"));
    await prepareCodexHome(dataDir, { CODEX_HOME: userHome });
    expect(await stat(join(dataDir, "codex-home", "AGENTS.md")).catch(() => undefined)).toBeUndefined();
  });
});
