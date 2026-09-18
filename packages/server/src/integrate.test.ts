import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { UIMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotTree } from "./checkpoints.js";
import { runCommand, type ToolExec } from "./exec.js";
import { createIntegrator, taskTarget, type TaskTarget } from "./integrate.js";
import type { Project } from "./types.js";

const exec = promisify(execFile);
const hasGit = spawnSync("git", ["--version"]).status === 0;

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgent-integrate-"));
  dirs.push(dir);
  return dir;
}

const run = (cwd: string, ...args: string[]) => exec("git", args, { cwd });
const porcelain = async (cwd: string) => (await run(cwd, "status", "--porcelain")).stdout;
const head = async (cwd: string) => (await run(cwd, "rev-parse", "HEAD")).stdout.trim();

/** A project checkout with one commit, plus a worktree task branched off it. */
async function worktreeTask(): Promise<{ project: string; work: string; base: string; target: TaskTarget }> {
  const project = await tempDir();
  await run(project, "init", "-q", "-b", "main");
  await run(project, "config", "user.email", "test@vgent.local");
  await run(project, "config", "user.name", "Vgent Test");
  await run(project, "config", "commit.gpgsign", "false");
  await writeFile(join(project, "tracked.txt"), "line1\nline2\n");
  await run(project, "add", "-A");
  await run(project, "commit", "-q", "-m", "初始");

  const base = await head(project);
  const work = join(await tempDir(), "wt");
  await run(project, "worktree", "add", "-q", "-b", "vgent/test", work, base);
  return {
    project,
    work,
    base,
    target: { mode: "worktree", repoPath: work, projectPath: project, branch: "vgent/test", baseCommit: base },
  };
}

/**
 * The user's own checkout, already dirty the way a real one is — a modified
 * file, an untracked one and a staged one — with a task whose 任务基线 was
 * pinned before it touched anything.
 */
async function projectTask(): Promise<{ project: string; target: TaskTarget; userLines: string[] }> {
  const project = await tempDir();
  await run(project, "init", "-q", "-b", "main");
  await run(project, "config", "user.email", "test@vgent.local");
  await run(project, "config", "user.name", "Vgent Test");
  await run(project, "config", "commit.gpgsign", "false");
  await writeFile(join(project, "tracked.txt"), "line1\nline2\n");
  await writeFile(join(project, "用户的.txt"), "原样\n");
  await writeFile(join(project, "暂存的.txt"), "原样\n");
  await run(project, "add", "-A");
  await run(project, "commit", "-q", "-m", "初始");

  await writeFile(join(project, "用户的.txt"), "原样\n用户改的\n");
  await writeFile(join(project, "用户没跟踪的.txt"), "用户建的\n");
  await writeFile(join(project, "暂存的.txt"), "原样\n用户暂存的\n");
  await run(project, "add", "暂存的.txt");
  const userLines = (await porcelain(project)).split("\n").filter((line) => line.trim() !== "");

  const baseline = await snapshotTree(project);
  return {
    project,
    target: { mode: "project", repoPath: project, projectPath: project, baseline: { tree: baseline } },
    userLines,
  };
}

/** The paths one commit carries. `core.quotepath` off, or every non-ASCII name comes back escaped. */
const committedPaths = async (cwd: string, rev = "HEAD") =>
  (await run(cwd, "-c", "core.quotepath=false", "show", "--pretty=format:", "--name-only", rev)).stdout
    .split("\n")
    .filter((line) => line.trim() !== "");

describe.skipIf(!hasGit)("createIntegrator", () => {
  it("主目录任务：只提交任务改的，用户自己的改动一件不动", async () => {
    const { project, target, userLines } = await projectTask();
    const integrator = createIntegrator();

    // Nothing done yet: the repo is dirty, but not by this task.
    expect(await integrator.status(target)).toMatchObject({ mode: "project", dirty: true, canCommit: false, commitFiles: 0 });
    await expect(integrator.integrate(target, { action: "commit", message: "空的" })).rejects.toMatchObject({
      code: "nothing_to_commit",
    });

    await writeFile(join(project, "tracked.txt"), "line1\nline2\n任务加的\n");
    await writeFile(join(project, "任务的.txt"), "任务建的\n");

    expect(await integrator.status(target)).toMatchObject({ canCommit: true, commitFiles: 2 });
    expect(await integrator.integrate(target, { action: "commit", message: "任务收个口" })).toMatchObject({ kind: "committed" });

    expect(await committedPaths(project)).toEqual(["tracked.txt", "任务的.txt"]);
    // Modified, untracked and staged: all three are still exactly as the user left them.
    expect((await porcelain(project)).split("\n").filter((line) => line.trim() !== "")).toEqual(userLines);

    // The baseline moves to the state right after the commit, the way the route
    // does it — so the task has nothing left to commit, twice over.
    const moved: TaskTarget = { ...target, baseline: { tree: await snapshotTree(project) } };
    expect(await integrator.status(moved)).toMatchObject({ canCommit: false, commitFiles: 0 });
    await expect(integrator.integrate(moved, { action: "commit", message: "再来一次" })).rejects.toMatchObject({
      code: "nothing_to_commit",
    });
  });

  it("主目录任务：基线功能之前建的任务照旧全提交，但把话说明白", async () => {
    const { project } = await projectTask();
    const legacy: TaskTarget = { mode: "project", repoPath: project, projectPath: project };
    const integrator = createIntegrator();

    const status = await integrator.status(legacy);
    expect(status).toMatchObject({ canCommit: true, note: expect.stringContaining("全部改动") });
    expect(status.commitFiles).toBeUndefined();

    expect(await integrator.integrate(legacy, { action: "commit", message: "老任务" })).toMatchObject({ kind: "committed" });
    expect(await committedPaths(project)).toEqual(["暂存的.txt", "用户没跟踪的.txt", "用户的.txt"]);
  });

  it("还没跑过回合的主目录任务：没有基线，就没有改动", async () => {
    const { project } = await projectTask();
    const fresh: TaskTarget = { mode: "project", repoPath: project, projectPath: project, baseline: { none: true } };
    const integrator = createIntegrator();

    const status = await integrator.status(fresh);
    expect(status).toMatchObject({ dirty: true, canCommit: false, commitFiles: 0 });
    expect(status.note).toBeUndefined();
    await expect(integrator.integrate(fresh, { action: "commit", message: "什么都没干" })).rejects.toMatchObject({
      code: "nothing_to_commit",
    });
  });

  it("提交：把任务目录里的一切落成一次提交", async () => {
    const { work, target } = await worktreeTask();
    const integrator = createIntegrator();

    await expect(integrator.integrate(target, { action: "commit", message: "做了点事" })).rejects.toMatchObject({
      code: "nothing_to_commit",
    });

    await writeFile(join(work, "tracked.txt"), "line1\n改了\n");
    await writeFile(join(work, "新文件.txt"), "新的\n");

    await expect(integrator.integrate(target, { action: "commit", message: "  " })).rejects.toMatchObject({
      code: "invalid_message",
    });

    const outcome = await integrator.integrate(target, { action: "commit", message: "做了点事" });
    expect(outcome).toMatchObject({ kind: "committed", ref: await head(work) });
    expect((await run(work, "log", "-1", "--pretty=%s")).stdout.trim()).toBe("做了点事");
    expect(await porcelain(work)).toBe("");

    const status = await integrator.status(target);
    expect(status).toMatchObject({ mode: "worktree", branch: "vgent/test", commitsAhead: 1, dirty: false, canCommit: false });
  });

  it("带回主目录：任务里提交过的和没提交的一起落到主检出", async () => {
    const { project, work, base, target } = await worktreeTask();

    await writeFile(join(work, "tracked.txt"), "line1\n任务改的\n");
    await writeFile(join(work, "新文件.txt"), "新的\n");
    await run(work, "add", "-A");
    await run(work, "commit", "-q", "-m", "任务自己的提交");
    await writeFile(join(work, "未跟踪.txt"), "还没提交\n");
    // A staged edit, so the worktree's own index is something we can check stayed put.
    await writeFile(join(work, "tracked.txt"), "line1\n任务改的\n再改一次\n");
    await run(work, "add", "tracked.txt");
    const indexBefore = await porcelain(work);

    const outcome = await createIntegrator().integrate(target, { action: "apply" });
    expect(outcome).toMatchObject({ kind: "applied" });

    expect(await readFile(join(project, "tracked.txt"), "utf8")).toBe("line1\n任务改的\n再改一次\n");
    expect(await readFile(join(project, "新文件.txt"), "utf8")).toBe("新的\n");
    expect(await readFile(join(project, "未跟踪.txt"), "utf8")).toBe("还没提交\n");
    // The project keeps its own HEAD: this lands as uncommitted work.
    expect(await head(project)).toBe(base);
    expect(await porcelain(project)).not.toBe("");
    // Nothing was staged or unstaged inside the worktree on our way through.
    expect(await porcelain(work)).toBe(indexBefore);
  });

  it("带回主目录：冲突时主检出一个字节都不动", async () => {
    const { project, work, target } = await worktreeTask();
    await writeFile(join(project, "tracked.txt"), "line1\n主目录自己改的\n");
    await writeFile(join(work, "tracked.txt"), "line1\n任务改的\n");

    await expect(createIntegrator().integrate(target, { action: "apply" })).rejects.toMatchObject({
      code: "apply_conflict",
      status: 409,
      message: expect.stringContaining("tracked.txt"),
    });
    expect(await readFile(join(project, "tracked.txt"), "utf8")).toBe("line1\n主目录自己改的\n");
  });

  it("带回主目录：没有改动就说没有", async () => {
    const { target } = await worktreeTask();
    await expect(createIntegrator().integrate(target, { action: "apply" })).rejects.toMatchObject({ code: "nothing_to_apply" });
  });

  it("全部丢弃：提交过的、改过的、没跟踪的一起回到基线", async () => {
    const { work, base, target } = await worktreeTask();
    await writeFile(join(work, "tracked.txt"), "line1\n改了\n");
    await run(work, "add", "-A");
    await run(work, "commit", "-q", "-m", "任务自己的提交");
    await writeFile(join(work, "未跟踪.txt"), "垃圾\n");

    expect(await createIntegrator().integrate(target, { action: "discard" })).toMatchObject({ kind: "discarded" });
    expect(await head(work)).toBe(base);
    expect(await porcelain(work)).toBe("");
    expect(await readFile(join(work, "tracked.txt"), "utf8")).toBe("line1\nline2\n");
  });

  it("主目录任务：只提供提交，不提供带回和丢弃", async () => {
    const { project } = await worktreeTask();
    const target: TaskTarget = { mode: "project", repoPath: project, projectPath: project };
    const integrator = createIntegrator();

    const status = await integrator.status(target);
    expect(status).toMatchObject({ mode: "project", commitsAhead: 0, canApply: false, canDiscardAll: false });
    expect(status.pr.available).toBe(false);

    await expect(integrator.integrate(target, { action: "discard" })).rejects.toMatchObject({ code: "action_unsupported" });

    await writeFile(join(project, "tracked.txt"), "line1\n主目录改的\n");
    expect(await integrator.integrate(target, { action: "commit", message: "在主目录提交" })).toMatchObject({ kind: "committed" });
    expect(await porcelain(project)).toBe("");
  });

  it("任务基线：worktree 任务用 baseCommit，主目录任务用 checkpoint，老任务退回 HEAD", () => {
    const project: Project = { id: "p1", name: "repo", repoPath: "/repo", createdAt: "2026-09-18T00:00:00.000Z" };
    const message: UIMessage = { id: "m1", role: "user", parts: [{ type: "text", text: "干活" }] };

    // Nothing has run yet: the task cannot have changed anything.
    expect(taskTarget({ messages: [] }, project)).toMatchObject({ mode: "project", baseline: { none: true } });
    // Its first turn pinned a baseline.
    expect(taskTarget({ messages: [message], baselineCommit: "a".repeat(40) }, project)).toMatchObject({
      baseline: { tree: "a".repeat(40) },
    });
    // Older than 任务基线: HEAD, the way it has always been.
    expect(taskTarget({ messages: [message] }, project).baseline).toBeUndefined();
    // A worktree task is untouched by any of this.
    const workspace = { mode: "worktree", path: "/wt", branch: "vgent/x", baseCommit: "b".repeat(40) } as const;
    expect(taskTarget({ messages: [], workspace }, project)).toMatchObject({
      mode: "worktree",
      baseCommit: "b".repeat(40),
      baseline: "b".repeat(40),
    });
  });

  it("开 PR：没有 origin 远端就说明原因，不显示按钮", async () => {
    const { target } = await worktreeTask();
    const status = await createIntegrator().status(target);
    expect(status.pr).toEqual({ available: false, reason: "仓库没有 origin 远端" });
  });

  it("开 PR：有 origin 但 gh 没登录也说明原因，并且一分钟只问一次", async () => {
    const { target, project } = await worktreeTask();
    await run(project, "remote", "add", "origin", "https://example.invalid/acme/repo.git");

    let probes = 0;
    const exec: ToolExec = async (file, args, options) => {
      if (file === "gh") {
        probes += 1;
        return { code: 1, stdout: "", stderr: "not logged in" };
      }
      return runCommand(file, args, options);
    };
    const integrator = createIntegrator({ exec });

    expect((await integrator.status(target)).pr).toEqual({ available: false, reason: "没找到已登录的 gh 命令行" });
    expect((await integrator.status(target)).pr).toEqual({ available: false, reason: "没找到已登录的 gh 命令行" });
    expect(probes).toBe(1);
  });

  it("开 PR：脏就先提交，再推送并新建 PR", async () => {
    const { work, target, project } = await worktreeTask();
    await run(project, "remote", "add", "origin", "https://example.invalid/acme/repo.git");
    await writeFile(join(work, "tracked.txt"), "line1\n改了\n");

    const calls: string[][] = [];
    const exec: ToolExec = async (file, args, options) => {
      if (file === "gh" || args[0] === "push") {
        calls.push([file, ...args]);
        if (file === "gh" && args[0] === "auth") return { code: 0, stdout: "", stderr: "" };
        if (file === "gh" && args[1] === "view") return { code: 1, stdout: "", stderr: "no pull requests found" };
        if (file === "gh" && args[1] === "create") {
          return { code: 0, stdout: "https://github.com/acme/repo/pull/7\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      return runCommand(file, args, options);
    };
    const integrator = createIntegrator({ exec });

    expect((await integrator.status(target)).pr).toEqual({ available: true });

    const outcome = await integrator.integrate(target, { action: "pr", message: "开个 PR" });
    expect(outcome).toMatchObject({ kind: "pr", url: "https://github.com/acme/repo/pull/7" });
    expect(calls).toContainEqual(["git", "push", "-u", "origin", "vgent/test"]);
    // The dirty tree was committed first, so the push had something to carry.
    expect(await porcelain(work)).toBe("");
    expect((await run(work, "log", "-1", "--pretty=%s")).stdout.trim()).toBe("开个 PR");
  });

  it("开 PR：已有的 PR 直接返回链接，推送失败是 502", async () => {
    const { work, target } = await worktreeTask();
    await writeFile(join(work, "tracked.txt"), "line1\n改了\n");
    await run(work, "add", "-A");
    await run(work, "commit", "-q", "-m", "任务自己的提交");

    const existing: ToolExec = async (file, args, options) => {
      if (file === "gh" && args[1] === "view") return { code: 0, stdout: '{"url":"https://github.com/acme/repo/pull/3"}', stderr: "" };
      if (args[0] === "push") return { code: 0, stdout: "", stderr: "" };
      return runCommand(file, args, options);
    };
    expect(await createIntegrator({ exec: existing }).integrate(target, { action: "pr" })).toMatchObject({
      kind: "pr",
      url: "https://github.com/acme/repo/pull/3",
    });

    const broken: ToolExec = async (file, args, options) =>
      args[0] === "push" ? { code: 1, stdout: "", stderr: "fatal: 远端拒绝了" } : runCommand(file, args, options);
    await expect(createIntegrator({ exec: broken }).integrate(target, { action: "pr" })).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("远端拒绝了"),
    });
  });
});
