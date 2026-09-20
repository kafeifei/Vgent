import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NO_PROJECT_ID, projectOfThread, scratchDirOf } from "./no-project.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const stored = { id: "p1", name: "Repo", repoPath: "/repo", createdAt: "x" };
const projects = { get: async (id: string) => (id === "p1" ? stored : undefined) };

describe("projectOfThread", () => {
  it("is the stored project for an ordinary task", async () => {
    expect(await projectOfThread(projects, "/data", { id: "t1", projectId: "p1" })).toBe(stored);
    expect(await projectOfThread(projects, "/data", { id: "t1", projectId: "gone" })).toBeUndefined();
  });

  it("gives a 无项目 task a directory of its own, made on the way", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vgent-scratch-"));
    dirs.push(dataDir);
    const a = await projectOfThread(projects, dataDir, { id: "t1", projectId: NO_PROJECT_ID });
    const b = await projectOfThread(projects, dataDir, { id: "t2", projectId: NO_PROJECT_ID });
    expect(a).toMatchObject({ id: NO_PROJECT_ID, name: "无项目", repoPath: scratchDirOf(dataDir, "t1") });
    // Two such tasks never see each other's files.
    expect(b?.repoPath).not.toBe(a?.repoPath);
    expect((await stat(a!.repoPath)).isDirectory()).toBe(true);
  });
});
