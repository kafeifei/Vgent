import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand, type ToolExec } from "./exec.js";
import { createIntegrator, type TaskTarget } from "./integrate.js";

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

describe.skipIf(!hasGit)("createIntegrator", () => {
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
