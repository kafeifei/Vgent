import { execFile, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { checkpointRefPrefix, discardScope, listCheckpointCommits, revertScope, snapshotTree } from "./checkpoints.js";
import { runCommand, type ToolExec } from "./exec.js";
import { createGit } from "./git.js";
import { createIntegrator, oneAtATime, type TaskTarget } from "./integrate.js";
import { silentLogger } from "./types.js";

const exec = promisify(execFile);
const hasGit = spawnSync("git", ["--version"]).status === 0;

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgent-integrate-safety-"));
  dirs.push(dir);
  return dir;
}

const run = (cwd: string, ...args: string[]) => exec("git", args, { cwd });
const read = (root: string, path: string) => readFile(join(root, path), "utf8");
const committedFiles = async (cwd: string) => (await run(cwd, "show", "--name-only", "--format=", "HEAD")).stdout.trim().split("\n").filter(Boolean);

/** A checkout with one commit of the given files. */
async function repo(files: Record<string, string>): Promise<string> {
  const project = await tempDir();
  await run(project, "init", "-q", "-b", "main");
  await run(project, "config", "user.email", "test@vgent.local");
  await run(project, "config", "user.name", "Vgent Test");
  await run(project, "config", "commit.gpgsign", "false");
  for (const [path, content] of Object.entries(files)) await writeFile(join(project, path), content);
  await run(project, "add", "-A");
  await run(project, "commit", "-q", "-m", "初始");
  return project;
}

/** A checkout with one commit, plus a worktree task branched off it. */
async function worktreeTask(): Promise<{ project: string; work: string; base: string; target: TaskTarget }> {
  const project = await repo({ "tracked.txt": "line1\n" });
  const base = (await run(project, "rev-parse", "HEAD")).stdout.trim();
  const work = join(await tempDir(), "wt");
  await run(project, "worktree", "add", "-q", "-b", "vgent/test", work, base);
  return { project, work, base, target: { mode: "worktree", repoPath: work, projectPath: project, branch: "vgent/test", baseCommit: base } };
}

describe.skipIf(!hasGit)("提交和还原只认文件名，不把它当通配", () => {
  // `[id].tsx` is a glob that matches `i.tsx` and `d.tsx`; the task only ever touched the first.
  const files = { "[id].tsx": "old id\n", "i.tsx": "old i\n" };

  it("提交：任务改了 [id].tsx，你任务前就改过的 i.tsx 不会被一起提交", async () => {
    const project = await repo(files);
    await writeFile(join(project, "i.tsx"), "你自己的、还没提交的改动\n");
    const target: TaskTarget = { mode: "project", repoPath: project, projectPath: project, baseline: { tree: await snapshotTree(project) } };
    await writeFile(join(project, "[id].tsx"), "task edit\n");

    await createIntegrator().integrate(target, { threadId: "t1", action: "commit", message: "任务的提交" });

    expect(await committedFiles(project)).toEqual(["[id].tsx"]);
    // Still the user's, still uncommitted.
    expect((await run(project, "status", "--porcelain")).stdout).toBe(" M i.tsx\n");
    expect(await read(project, "i.tsx")).toBe("你自己的、还没提交的改动\n");
  });

  it("还原：还原 [id].tsx 不会把你之后改的 i.tsx 一起打回基线", async () => {
    const project = await repo(files);
    const baseline = await snapshotTree(project);
    await writeFile(join(project, "[id].tsx"), "task edit\n");
    await writeFile(join(project, "i.tsx"), "你在任务开跑之后改的\n");

    await createGit().revert(project, "[id].tsx", { tree: baseline });

    expect(await read(project, "[id].tsx")).toBe("old id\n");
    expect(await read(project, "i.tsx")).toBe("你在任务开跑之后改的\n");
  });
});

describe.skipIf(!hasGit)("提交：路径按字面交给 git，钩子里的通配照常", () => {
  it("pre-commit 钩子里的 '*.ts' 照样看得到 [id].ts；a*.txt 按字面提交，ab.txt 和 i.ts 不动", async () => {
    const project = await repo({ "[id].ts": "old id\n", "i.ts": "old i\n", "a*.txt": "old a\n", "ab.txt": "old ab\n" });
    // The user's own lint gate, which finds what is being committed through a glob of its own.
    const hooks = await tempDir();
    await writeFile(join(hooks, "pre-commit"), `#!/bin/sh\ngit diff --cached --name-only -- '*.ts' > "${join(hooks, "saw")}"\n`);
    await chmod(join(hooks, "pre-commit"), 0o755);
    await run(project, "config", "core.hooksPath", hooks);
    await writeFile(join(project, "i.ts"), "你自己的\n");
    await writeFile(join(project, "ab.txt"), "你自己的\n");
    const target: TaskTarget = { mode: "project", repoPath: project, projectPath: project, baseline: { tree: await snapshotTree(project) } };
    await writeFile(join(project, "[id].ts"), "task\n");
    await writeFile(join(project, "a*.txt"), "task\n");

    await createIntegrator().integrate(target, { threadId: "t1", action: "commit", message: "任务的提交" });

    expect((await committedFiles(project)).sort()).toEqual(["[id].ts", "a*.txt"]);
    expect(await read(hooks, "saw")).toBe("[id].ts\n");
    expect((await run(project, "status", "--porcelain")).stdout).toBe(" M ab.txt\n M i.ts\n");
  });
});

describe.skipIf(!hasGit)("提交：你的暂存区要么原样，要么只多了这次提交", () => {
  it("任务的 .gitignore 盖住了开跑前就在的未跟踪文件：照样提交，暂存区不留半截", async () => {
    const project = await repo({ "keep.txt": "a\n" });
    await mkdir(join(project, "out"));
    await writeFile(join(project, "out", "a"), "构建产物\n");
    const target: TaskTarget = { mode: "project", repoPath: project, projectPath: project, baseline: { tree: await snapshotTree(project) } };
    await writeFile(join(project, ".gitignore"), "out/\n");

    await createIntegrator().integrate(target, { threadId: "t1", action: "commit", message: "任务的提交" });

    expect(await committedFiles(project)).toEqual([".gitignore"]);
    expect((await run(project, "status", "--porcelain")).stdout).toBe("");
    expect(await read(project, "out/a")).toBe("构建产物\n");
  });

  /** A main-checkout task that changed one file and created another, next to a file the user staged. */
  async function dirtyProject(): Promise<{ project: string; target: TaskTarget; before: string }> {
    const project = await repo({ "keep.txt": "a\n", "staged.txt": "a\n" });
    await writeFile(join(project, "staged.txt"), "你暂存的\n");
    await run(project, "add", "staged.txt");
    const target: TaskTarget = { mode: "project", repoPath: project, projectPath: project, baseline: { tree: await snapshotTree(project) } };
    await writeFile(join(project, "keep.txt"), "任务改的\n");
    await writeFile(join(project, "new.txt"), "任务建的\n");
    return { project, target, before: (await run(project, "status", "--porcelain")).stdout };
  }

  it("git add 暂存到一半失败：暂存区回到提交之前的样子", async () => {
    const { project, target, before } = await dirtyProject();
    // git stages what it can, then fails on the rest.
    const halfway: ToolExec = async (file, args, options) => {
      const result = await runCommand(file, args, options);
      const scoped = args[0] === "add" && args.some((arg) => arg.startsWith("--pathspec-from-file="));
      return scoped ? { code: 1, stdout: "", stderr: "error: 模拟的失败" } : result;
    };

    await expect(createIntegrator({ exec: halfway }).integrate(target, { threadId: "t1", action: "commit", message: "任务的提交" })).rejects.toThrow();
    expect((await run(project, "status", "--porcelain")).stdout).toBe(before);
  });

  it("pre-commit 钩子拒绝了提交：任务的文件不会留在暂存区里", async () => {
    const { project, target, before } = await dirtyProject();
    const hooks = await tempDir();
    await writeFile(join(hooks, "pre-commit"), "#!/bin/sh\necho 不许提交 >&2\nexit 1\n");
    await chmod(join(hooks, "pre-commit"), 0o755);
    await run(project, "config", "core.hooksPath", hooks);

    await expect(createIntegrator().integrate(target, { threadId: "t1", action: "commit", message: "任务的提交" })).rejects.toMatchObject({
      code: "commit_failed",
    });
    expect((await run(project, "status", "--porcelain")).stdout).toBe(before);
  });
});

describe.skipIf(!hasGit)("同一个检出上的写操作一个一个来", () => {
  it("带回写到一半时，同一检出上的提交和还原、恢复都等它写完", async () => {
    const { project, work, target } = await worktreeTask();
    await writeFile(join(work, "tracked.txt"), "line1\n任务加的\n");
    // A main-checkout task in the same checkout, with a change of its own.
    const own: TaskTarget = { mode: "project", repoPath: project, projectPath: project, baseline: { tree: await snapshotTree(project) } };
    await writeFile(join(project, "own.txt"), "主目录任务的\n");

    const events: string[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((done) => (release = done));
    let writing = (): void => {};
    const started = new Promise<void>((done) => (writing = done));
    // The 带回 stops right where it starts writing into the checkout.
    const gated: ToolExec = async (file, args, options) => {
      if (args[0] === "checkout-index" && options.cwd === project) {
        writing();
        await gate;
        events.push("带回写完");
      }
      return runCommand(file, args, options);
    };
    const watched: ToolExec = async (file, args, options) => {
      if (!events.includes("提交开始")) events.push("提交开始");
      return runCommand(file, args, options);
    };

    const applying = createIntegrator({ exec: gated }).integrate(target, { threadId: "t1", action: "apply" });
    await started;
    const committing = createIntegrator({ exec: watched }).integrate(own, { threadId: "t2", action: "commit", message: "主目录任务的提交" });
    // What 还原 and 恢复到此处 run through.
    const restoring = oneAtATime(project, async () => {
      events.push("还原开始");
    });
    await new Promise((wake) => setTimeout(wake, 100));
    events.push("放行");
    release();
    await Promise.all([applying, committing, restoring]);

    expect(events).toEqual(["放行", "带回写完", "提交开始", "还原开始"]);
  });
});

describe.skipIf(!hasGit)("提交：任务删掉一个开跑前就未跟踪的文件", () => {
  it("不会因为 git 找不到这个路径而整个提交失败", async () => {
    const project = await repo({ "keep.txt": "a\n" });
    // Lying there untracked when the task starts — so it is in the baseline — and deleted by the task.
    await writeFile(join(project, "scratch.txt"), "用户的草稿\n");
    const target: TaskTarget = { mode: "project", repoPath: project, projectPath: project, baseline: { tree: await snapshotTree(project) } };
    await unlink(join(project, "scratch.txt"));
    await writeFile(join(project, "keep.txt"), "a\nb\n");

    await createIntegrator().integrate(target, { threadId: "t1", action: "commit", message: "任务的提交" });

    expect(await committedFiles(project)).toEqual(["keep.txt"]);
  });

  it("只剩这样的路径时，说没有可提交的改动，而不是 500", async () => {
    const project = await repo({ "keep.txt": "a\n" });
    await writeFile(join(project, "scratch.txt"), "用户的草稿\n");
    const target: TaskTarget = { mode: "project", repoPath: project, projectPath: project, baseline: { tree: await snapshotTree(project) } };
    await unlink(join(project, "scratch.txt"));

    const failure = await createIntegrator()
      .integrate(target, { threadId: "t1", action: "commit", message: "任务的提交" })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "nothing_to_commit", status: 400 });
  });
});

describe.skipIf(!hasGit)("全部丢弃", () => {
  it("工作目录已经不在任务的分支上时，不动那条分支", async () => {
    const { work, target } = await worktreeTask();
    await run(work, "checkout", "-q", "-b", "somebody-elses-work");
    await writeFile(join(work, "theirs.txt"), "别人的活\n");
    await run(work, "add", "-A");
    await run(work, "commit", "-q", "-m", "别的分支上的提交");
    const tip = (await run(work, "rev-parse", "HEAD")).stdout.trim();

    const failure = await createIntegrator()
      .integrate(target, { threadId: "t1", action: "discard" })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "discard_wrong_branch", status: 409 });
    expect((await run(work, "rev-parse", "HEAD")).stdout.trim()).toBe(tip);
    expect(await read(work, "theirs.txt")).toBe("别人的活\n");
  });

  it("丢掉之前先留底：任务的提交和没提交的文件事后都还能找回", async () => {
    const { work, target } = await worktreeTask();
    await writeFile(join(work, "committed.txt"), "任务提交过的\n");
    await run(work, "add", "-A");
    await run(work, "commit", "-q", "-m", "任务的提交");
    await writeFile(join(work, "uncommitted.txt"), "任务还没提交的\n");

    const result = await createIntegrator().integrate(target, { threadId: "t1", action: "discard" });
    expect(result.outcome).toMatchObject({ kind: "discarded" });
    // The worktree is back at the baseline …
    expect((await run(work, "status", "--porcelain")).stdout).toBe("");
    await expect(readFile(join(work, "committed.txt"), "utf8")).rejects.toThrow();

    // … and everything it held is still reachable from the one ref that was kept.
    const [commit] = await listCheckpointCommits({ repoPath: work, threadId: discardScope("t1") });
    expect(commit).toBeDefined();
    expect((await run(work, "show", `${commit}:committed.txt`)).stdout).toBe("任务提交过的\n");
    expect((await run(work, "show", `${commit}:uncommitted.txt`)).stdout).toBe("任务还没提交的\n");
  });
});

describe.skipIf(!hasGit)("worktree 任务的提交与带回", () => {
  it("git 被配置成不显示未跟踪文件时，只新建了文件的任务照样能提交", async () => {
    const { project, work, target } = await worktreeTask();
    await run(project, "config", "status.showUntrackedFiles", "no");
    await writeFile(join(work, "new.txt"), "任务新建的\n");

    expect(await createIntegrator().status(target)).toMatchObject({ dirty: true });
    await createIntegrator().integrate(target, { threadId: "t1", action: "commit", message: "任务的提交" });

    expect(await committedFiles(work)).toEqual(["new.txt"]);
  });

  it("同时向同一个主目录带回两次：一次落地，另一次看到的已经是落地之后的样子", async () => {
    const { project, work, target } = await worktreeTask();
    await writeFile(join(work, "tracked.txt"), "line1\n任务加的\n");
    const integrator = createIntegrator();

    const [first, second] = await Promise.allSettled([
      integrator.integrate(target, { threadId: "t1", action: "apply" }),
      integrator.integrate(target, { threadId: "t1", action: "apply" }),
    ]);

    expect(first.status).toBe("fulfilled");
    expect(second).toMatchObject({ status: "rejected", reason: { code: "nothing_to_apply" } });
    expect(await read(project, "tracked.txt")).toBe("line1\n任务加的\n");
  });
});

describe.skipIf(!hasGit)("按文件还原", () => {
  it("还原之前先留一份现场：你在任务开跑后往这个文件里敲的字还找得回来", async () => {
    const project = await repo({ "a.txt": "原样\n" });
    const baseline = await snapshotTree(project);
    await writeFile(join(project, "a.txt"), "你在任务开跑之后敲的\n");

    await createGit().revert(project, "a.txt", { tree: baseline }, { threadId: "t1" });

    expect(await read(project, "a.txt")).toBe("原样\n");
    const [commit] = await listCheckpointCommits({ repoPath: project, threadId: revertScope("t1") });
    expect(commit).toBeDefined();
    expect((await run(project, "show", `${commit}:a.txt`)).stdout).toBe("你在任务开跑之后敲的\n");
  });

  it("留不了底就不还原，也不是悄悄地", async () => {
    const project = await repo({ "a.txt": "原样\n" });
    const baseline = await snapshotTree(project);
    await writeFile(join(project, "a.txt"), "你在任务开跑之后敲的\n");
    // A ref where the snapshot's own directory of refs would go: nothing can be kept under it.
    await run(project, "update-ref", checkpointRefPrefix(revertScope("t1")), "HEAD");
    const warnings: unknown[] = [];

    const failure = await createGit()
      .revert(project, "a.txt", { tree: baseline }, { threadId: "t1", log: { ...silentLogger, warn: (...args: unknown[]) => warnings.push(args) } })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "checkpoint_failed", status: 500 });
    expect(await read(project, "a.txt")).toBe("你在任务开跑之后敲的\n");
    expect(warnings).toHaveLength(1);
  });

  it("不带 threadId 就不留（内部调用方不受影响）", async () => {
    const project = await repo({ "a.txt": "原样\n" });
    const baseline = await snapshotTree(project);
    await writeFile(join(project, "a.txt"), "改过\n");

    await createGit().revert(project, "a.txt", { tree: baseline });

    expect(await read(project, "a.txt")).toBe("原样\n");
    expect(await listCheckpointCommits({ repoPath: project, threadId: revertScope("t1") })).toEqual([]);
  });
});
