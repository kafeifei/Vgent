import { execFile, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { planThreeWayApply, runApplyPlan } from "./apply.js";
import { listCheckpointCommits, snapshotTree } from "./checkpoints.js";
import { createIntegrator, type TaskTarget } from "./integrate.js";
import type { ApplyConflict, ApplyUndoRecord } from "./index.js";

const exec = promisify(execFile);
const hasGit = spawnSync("git", ["--version"]).status === 0;

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgent-apply-test-"));
  dirs.push(dir);
  return dir;
}

const run = (cwd: string, ...args: string[]) => exec("git", args, { cwd });
const porcelain = async (cwd: string) => (await run(cwd, "-c", "core.quotepath=false", "status", "--porcelain")).stdout;
const staged = async (cwd: string) => (await run(cwd, "-c", "core.quotepath=false", "diff", "--cached")).stdout;
const read = (root: string, path: string) => readFile(join(root, path), "utf8");
const missing = async (root: string, path: string) => (await stat(join(root, path)).catch(() => null)) == null;

/**
 * The user's own checkout, dirty the way a real one is — an edit of their own,
 * an untracked file and a staged one — plus a worktree task branched off the
 * same commit. Everything a 带回主目录 test needs is already in place.
 */
async function fixture(): Promise<{ project: string; work: string; target: TaskTarget }> {
  const project = await tempDir();
  await run(project, "init", "-q", "-b", "main");
  await run(project, "config", "user.email", "test@vgent.local");
  await run(project, "config", "user.name", "Vgent Test");
  await run(project, "config", "commit.gpgsign", "false");

  await writeFile(join(project, "共享.txt"), ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"].join("\n") + "\n");
  await writeFile(join(project, "任务改的.txt"), "原样\n");
  await writeFile(join(project, "任务删的.txt"), "要被删掉\n");
  await writeFile(join(project, "任务改模式的.sh"), "#!/bin/sh\necho hi\n");
  await writeFile(join(project, "改名前.txt"), "搬家\n");
  await writeFile(join(project, "图片.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
  await mkdir(join(project, "深/一层"), { recursive: true });
  await writeFile(join(project, "深/一层/深的.txt"), "深处\n");
  await writeFile(join(project, "用户暂存的.txt"), "原样\n");
  await run(project, "add", "-A");
  await run(project, "commit", "-q", "-m", "初始");

  const base = (await run(project, "rev-parse", "HEAD")).stdout.trim();
  const work = join(await tempDir(), "wt");
  await run(project, "worktree", "add", "-q", "-b", "vgent/test", work, base);

  // The user's own uncommitted work, all three kinds.
  await writeFile(join(project, "用户自己的.txt"), "只有用户动过\n");
  await writeFile(join(project, "用户暂存的.txt"), "原样\n用户暂存的\n");
  await run(project, "add", "用户暂存的.txt");

  return {
    project,
    work,
    target: { mode: "worktree", repoPath: work, projectPath: project, branch: "vgent/test", baseCommit: base, baseline: base },
  };
}

const reasons = (conflicts: readonly ApplyConflict[]): Record<string, string> =>
  Object.fromEntries(conflicts.map((entry) => [entry.path, entry.resolution]));

describe.skipIf(!hasGit)("带回主目录", () => {
  it("逐文件三方合并：新增、删除、改动、模式、重命名、子目录", async () => {
    const { project, work, target } = await fixture();
    const stagedBefore = await staged(project);
    const porcelainBefore = await porcelain(project);

    // Added, twice: one the project has never seen, one it already has byte for byte.
    await writeFile(join(work, "任务新建的.txt"), "任务建的\n");
    await writeFile(join(project, "两边都建了.txt"), "一模一样\n");
    await writeFile(join(work, "两边都建了.txt"), "一模一样\n");
    // Deleted by the task, untouched by the user.
    await rm(join(work, "任务删的.txt"));
    // Modified by the task, untouched by the user.
    await writeFile(join(work, "任务改的.txt"), "任务改过了\n");
    // Both changed the same file, in different places: a real three-way merge.
    await writeFile(join(work, "共享.txt"), ["任务加的开头", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"].join("\n") + "\n");
    await writeFile(join(project, "共享.txt"), ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "用户加的结尾"].join("\n") + "\n");
    // Mode only.
    await chmod(join(work, "任务改模式的.sh"), 0o755);
    // A rename, which `--no-renames` turns into a delete and an add.
    await run(work, "mv", "改名前.txt", "改名后.txt");
    // A file in a subdirectory the project does not have yet.
    await mkdir(join(work, "新目录"), { recursive: true });
    await writeFile(join(work, "新目录/新的.txt"), "新目录里的\n");

    const result = await createIntegrator().integrate(target, { threadId: "t1", action: "apply" });
    expect(result.outcome).toMatchObject({ kind: "applied" });
    expect(result.apply?.conflicts).toEqual([]);

    expect(await read(project, "任务新建的.txt")).toBe("任务建的\n");
    expect(await missing(project, "任务删的.txt")).toBe(true);
    expect(await read(project, "任务改的.txt")).toBe("任务改过了\n");
    expect(await read(project, "共享.txt")).toBe(
      ["任务加的开头", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "用户加的结尾"].join("\n") + "\n",
    );
    expect(((await stat(join(project, "任务改模式的.sh"))).mode & 0o111) !== 0).toBe(true);
    expect(await missing(project, "改名前.txt")).toBe(true);
    expect(await read(project, "改名后.txt")).toBe("搬家\n");
    expect(await read(project, "新目录/新的.txt")).toBe("新目录里的\n");
    // Nothing was written for the file both sides created identically.
    expect(result.apply?.applied).not.toContain("两边都建了.txt");

    // The user's own work is untouched, and so is their index: 带回 writes
    // files, it never stages.
    expect(await read(project, "用户自己的.txt")).toBe("只有用户动过\n");
    expect(await staged(project)).toBe(stagedBefore);
    expect(porcelainBefore).toContain("M  用户暂存的.txt");
    expect(await porcelain(project)).toContain("M  用户暂存的.txt");
    // And the worktree's own index never moved either.
    expect(await porcelain(work)).toContain("?? 任务新建的.txt");
  });

  it("冲突：默认整体不动，409 里带着每个文件和原因", async () => {
    const { project, work, target } = await fixture();

    // 1. Both edited the same lines of a text file.
    await writeFile(join(work, "共享.txt"), "任务全写了\n");
    await writeFile(join(project, "共享.txt"), "用户全写了\n");
    // 2. Both changed a binary file.
    await writeFile(join(work, "图片.bin"), Buffer.from([0, 9, 9, 9]));
    await writeFile(join(project, "图片.bin"), Buffer.from([0, 7, 7, 7]));
    // 3. The task deleted a file the user had been editing.
    await rm(join(work, "任务删的.txt"));
    await writeFile(join(project, "任务删的.txt"), "用户还在改它\n");
    // 4. The user deleted a file the task changed.
    await writeFile(join(work, "深/一层/深的.txt"), "任务改深处\n");
    await rm(join(project, "深/一层/深的.txt"));
    const before = await porcelain(project);

    const failure = await createIntegrator()
      .integrate(target, { threadId: "t1", action: "apply" })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "apply_conflict", status: 409 });
    const conflicts = (failure as { details: { conflicts: ApplyConflict[] } }).details.conflicts;
    expect(reasons(conflicts)).toEqual({
      "共享.txt": "markers",
      "图片.bin": "skipped",
      "任务删的.txt": "skipped",
      "深/一层/深的.txt": "skipped",
    });

    // Not one byte moved in the project.
    expect(await read(project, "共享.txt")).toBe("用户全写了\n");
    expect(await readFile(join(project, "图片.bin"))).toEqual(Buffer.from([0, 7, 7, 7]));
    expect(await read(project, "任务删的.txt")).toBe("用户还在改它\n");
    expect(await missing(project, "深/一层/深的.txt")).toBe(true);
    expect(await porcelain(project)).toBe(before);
  });

  it("二进制：只有任务动过就照样带回，两边都动过才算冲突", async () => {
    const { project, work, target } = await fixture();
    await writeFile(join(work, "图片.bin"), Buffer.from([0, 4, 4, 4]));

    const result = await createIntegrator().integrate(target, { threadId: "t1", action: "apply" });
    expect(result.apply).toMatchObject({ applied: ["图片.bin"], conflicts: [] });
    expect(await readFile(join(project, "图片.bin"))).toEqual(Buffer.from([0, 4, 4, 4]));
  });

  it("符号链接：只有任务改过就跟着走，两边都改过算冲突", async () => {
    const { project, work, target } = await fixture();
    // The task re-points a link the user has not touched.
    await symlink("任务改的.txt", join(work, "链接"));
    expect(await createIntegrator().integrate(target, { threadId: "t1", action: "apply" })).toMatchObject({
      apply: { applied: ["链接"], conflicts: [] },
    });
    expect(await readlink(join(project, "链接"))).toBe("任务改的.txt");

    // Now both sides point it somewhere else: nothing to merge line by line.
    await rm(join(work, "链接"));
    await symlink("共享.txt", join(work, "链接"));
    await rm(join(project, "链接"));
    await symlink("任务删的.txt", join(project, "链接"));
    const failure = await createIntegrator()
      .integrate(target, { threadId: "t1", action: "apply" })
      .catch((error: unknown) => error);
    expect((failure as { details: { conflicts: ApplyConflict[] } }).details.conflicts).toEqual([
      { path: "链接", resolution: "skipped", reason: "符号链接在两边都变了" },
    ]);
    expect(await readlink(join(project, "链接"))).toBe("任务删的.txt");
  });

  it("带冲突标记合并：文本写标记，二进制跳过，干净的照常落地", async () => {
    const { project, work, target } = await fixture();
    await writeFile(join(work, "共享.txt"), ["任务写的", "二", "三", "四", "五", "六", "七", "八", "九", "十"].join("\n") + "\n");
    await writeFile(join(project, "共享.txt"), ["用户写的", "二", "三", "四", "五", "六", "七", "八", "九", "十"].join("\n") + "\n");
    await writeFile(join(work, "图片.bin"), Buffer.from([0, 9, 9, 9]));
    await writeFile(join(project, "图片.bin"), Buffer.from([0, 7, 7, 7]));
    await writeFile(join(work, "任务改的.txt"), "任务改过了\n");

    const result = await createIntegrator().integrate(target, { threadId: "t1", action: "apply", conflicts: "markers" });
    expect(result.outcome).toMatchObject({ kind: "applied" });
    expect(result.apply?.applied).toEqual(["任务改的.txt"]);
    expect(reasons(result.apply?.conflicts ?? [])).toEqual({ "共享.txt": "markers", "图片.bin": "skipped" });

    const merged = await read(project, "共享.txt");
    expect(merged).toContain("<<<<<<< 你的改动");
    expect(merged).toContain("用户写的");
    expect(merged).toContain(">>>>>>> 任务的改动");
    expect(merged).toContain("任务写的");
    // The binary is left exactly as the user had it, and the clean file landed.
    expect(await readFile(join(project, "图片.bin"))).toEqual(Buffer.from([0, 7, 7, 7]));
    expect(await read(project, "任务改的.txt")).toBe("任务改过了\n");
  });

  it("撤销带回：没动过的放回去，你之后改过的留着", async () => {
    const { project, work, target } = await fixture();
    const integrator = createIntegrator();
    await writeFile(join(work, "任务新建的.txt"), "任务建的\n");
    await writeFile(join(work, "任务改的.txt"), "任务改过了\n");
    await rm(join(work, "任务删的.txt"));
    const stagedBefore = await staged(project);

    const applied = await integrator.integrate(target, { threadId: "t1", action: "apply" });
    const record = applied.applyUndo as ApplyUndoRecord;
    expect([...record.files.map((file) => file.path)].sort()).toEqual(["任务删的.txt", "任务改的.txt", "任务新建的.txt"].sort());

    // The user gets to work on one of the applied files before changing their mind.
    await writeFile(join(project, "任务改的.txt"), "用户又改了一遍\n");

    const undone = await integrator.integrate(target, { threadId: "t1", action: "undo-apply", applyUndo: record });
    expect(undone.outcome).toBeNull();
    expect(undone.applyUndo).toBeNull();
    expect([...(undone.undo?.restored ?? [])].sort()).toEqual(["任务删的.txt", "任务新建的.txt"].sort());
    expect(undone.undo?.kept).toEqual(["任务改的.txt"]);

    // Put back: the created file is gone again and the deleted one is back.
    expect(await missing(project, "任务新建的.txt")).toBe(true);
    expect(await read(project, "任务删的.txt")).toBe("要被删掉\n");
    // Left alone: the one the user has since edited.
    expect(await read(project, "任务改的.txt")).toBe("用户又改了一遍\n");
    // And the undo did not stage anything either.
    expect(await staged(project)).toBe(stagedBefore);
  });

  it("撤销带回：没有记录就说没有，快照没了就说撤不了", async () => {
    const { target } = await fixture();
    const integrator = createIntegrator();
    await expect(integrator.integrate(target, { threadId: "t1", action: "undo-apply" })).rejects.toMatchObject({
      code: "nothing_to_undo",
    });

    const ghost: ApplyUndoRecord = { snapshot: "0".repeat(40), files: [], at: new Date().toISOString() };
    await expect(integrator.integrate(target, { threadId: "t1", action: "undo-apply", applyUndo: ghost })).rejects.toMatchObject({
      code: "undo_unavailable",
      status: 409,
    });
  });

  it("带回的撤销点存在任务自己的 ref 里，不会混进「恢复到此处」", async () => {
    const { project, work, target } = await fixture();
    await writeFile(join(work, "任务改的.txt"), "任务改过了\n");
    await createIntegrator().integrate(target, { threadId: "t1", action: "apply" });

    const refs = (await run(project, "for-each-ref", "--format=%(refname)", "--", "refs/vgent/checkpoints/t1/")).stdout
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatch(/^refs\/vgent\/checkpoints\/t1\/apply\/\d+$/);
    // 「恢复到此处」 only ever offers numbered checkpoints, so this one — a
    // snapshot of the *project*, not of the task's worktree — is not among them.
    expect(await listCheckpointCommits({ repoPath: work, threadId: "t1" })).toEqual([]);
  });
});

describe.skipIf(!hasGit)("带回主目录：类型冲突与写入前的变化", () => {
  const apply = (target: TaskTarget, conflicts?: "markers") =>
    createIntegrator().integrate(target, { threadId: "t1", action: "apply", ...(conflicts != null ? { conflicts } : {}) });
  const conflictsOf = (failure: unknown) => (failure as { details: { conflicts: ApplyConflict[] } }).details.conflicts;

  it("任务新建的文件撞上你主目录里未跟踪的同名目录：目录原样留着，报成冲突", async () => {
    const { project, work, target } = await fixture();
    await writeFile(join(work, "notes"), "任务新建了一个叫 notes 的文件\n");
    await mkdir(join(project, "notes"));
    await writeFile(join(project, "notes", "todo.txt"), "你自己的未跟踪目录\n");
    await writeFile(join(project, "notes", "ideas.txt"), "还有别的\n");

    const failure = await apply(target).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "apply_conflict", status: 409 });
    expect(conflictsOf(failure)).toEqual([{ path: "notes", resolution: "skipped", reason: "主目录里这个路径是个目录，任务在这里放了个文件" }]);
    expect(await read(project, "notes/todo.txt")).toBe("你自己的未跟踪目录\n");
    expect(await read(project, "notes/ideas.txt")).toBe("还有别的\n");

    // Told to apply what it can, it still leaves the directory alone — and carries the rest.
    await writeFile(join(work, "任务改的.txt"), "任务改了\n");
    const partial = await apply(target, "markers");
    expect(partial.apply?.conflicts).toEqual([{ path: "notes", resolution: "skipped", reason: "主目录里这个路径是个目录，任务在这里放了个文件" }]);
    expect(partial.apply?.applied).toEqual(["任务改的.txt"]);
    expect(await read(project, "notes/todo.txt")).toBe("你自己的未跟踪目录\n");
    expect((await stat(join(project, "notes"))).isDirectory()).toBe(true);
  });

  it("任务把一个文件换成同名目录：不崩、不半应用，两边都原样", async () => {
    const { project, work, target } = await fixture();
    await rm(join(work, "任务改的.txt"));
    await mkdir(join(work, "任务改的.txt"));
    await writeFile(join(work, "任务改的.txt", "a.txt"), "A\n");
    await writeFile(join(work, "任务改的.txt", "b.txt"), "B\n");

    const failure = await apply(target).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "apply_conflict", status: 409 });
    expect(reasons(conflictsOf(failure))).toEqual({ "任务改的.txt": "skipped", "任务改的.txt/a.txt": "skipped", "任务改的.txt/b.txt": "skipped" });
    // The user's file is still a file, with its content.
    expect(await read(project, "任务改的.txt")).toBe("原样\n");

    // Applying "what can be" must not delete the file while refusing to create the directory that replaces it.
    const partial = await apply(target, "markers");
    expect(partial.apply?.applied).toEqual([]);
    expect(await read(project, "任务改的.txt")).toBe("原样\n");
  });

  it("任务把一个目录换成同名文件：你在目录里的未跟踪文件不会被换掉", async () => {
    const { project, work, target } = await fixture();
    await rm(join(work, "深"), { recursive: true });
    await writeFile(join(work, "深"), "任务把目录换成了文件\n");
    await writeFile(join(project, "深/一层/我的.txt"), "你在这个目录里的未跟踪文件\n");

    const failure = await apply(target).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "apply_conflict", status: 409 });
    expect(conflictsOf(failure).map((entry) => entry.path)).toContain("深");
    expect(await read(project, "深/一层/我的.txt")).toBe("你在这个目录里的未跟踪文件\n");

    await apply(target, "markers");
    expect((await stat(join(project, "深"))).isDirectory()).toBe(true);
    expect(await read(project, "深/一层/我的.txt")).toBe("你在这个目录里的未跟踪文件\n");
  });

  it("计划做好之后、写入之前你又存了这个文件：不覆盖它，报出来", async () => {
    const { project, work, target } = await fixture();
    await writeFile(join(work, "任务改的.txt"), "任务改了\n");
    const theirs = await snapshotTree(work);
    const plan = await planThreeWayApply({ worktreePath: work, projectPath: project, base: target.baseCommit!, theirs });
    expect(plan.applied).toEqual(["任务改的.txt"]);

    // The window between deciding and writing.
    await writeFile(join(project, "任务改的.txt"), "你刚存的\n");
    const outcome = await runApplyPlan({ projectPath: project, theirs, plan });

    expect(await read(project, "任务改的.txt")).toBe("你刚存的\n");
    expect(outcome.applied).toEqual([]);
    expect(outcome.conflicts).toEqual([{ path: "任务改的.txt", resolution: "skipped", reason: "写入前这个文件又变了，没有动它" }]);
    expect(outcome.files).toEqual([]);
  });

  it("写了冲突标记的计划，写入前文件又变了：报告里不再说「已写入冲突标记」", async () => {
    const { project, work, target } = await fixture();
    await writeFile(join(project, "任务改的.txt"), "你先改的\n");
    await writeFile(join(work, "任务改的.txt"), "任务也改了同一行\n");
    const theirs = await snapshotTree(work);
    const plan = await planThreeWayApply({ worktreePath: work, projectPath: project, base: target.baseCommit!, theirs, conflicts: "markers" });
    expect(plan.conflicts).toEqual([expect.objectContaining({ path: "任务改的.txt", resolution: "markers" })]);
    expect(plan.steps).toHaveLength(1);

    await writeFile(join(project, "任务改的.txt"), "你刚存的\n");
    const outcome = await runApplyPlan({ projectPath: project, theirs, plan });

    expect(await read(project, "任务改的.txt")).toBe("你刚存的\n");
    // One entry for the one path, and it says what happened: nothing was written.
    expect(outcome.conflicts).toEqual([{ path: "任务改的.txt", resolution: "skipped", reason: "写入前这个文件又变了，没有动它" }]);
  });
});

/** A project with just `files` committed, and a worktree task branched off it. */
async function taskOn(files: Record<string, string>): Promise<{ project: string; work: string; target: TaskTarget }> {
  const project = await tempDir();
  await run(project, "init", "-q", "-b", "main");
  await run(project, "config", "user.email", "test@vgent.local");
  await run(project, "config", "user.name", "Vgent Test");
  await run(project, "config", "commit.gpgsign", "false");
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(project, path)), { recursive: true });
    await writeFile(join(project, path), content);
  }
  await run(project, "add", "-A");
  await run(project, "commit", "-q", "-m", "初始");
  const base = (await run(project, "rev-parse", "HEAD")).stdout.trim();
  const work = join(await tempDir(), "wt");
  await run(project, "worktree", "add", "-q", "-b", "vgent/test", work, base);
  return { project, work, target: { mode: "worktree", repoPath: work, projectPath: project, branch: "vgent/test", baseCommit: base, baseline: base } };
}

/** The names as they really are on disk — `stat` would find `README.md` through `Readme.md` on a disk that ignores case. */
const names = async (dir: string) => (await readdir(dir)).filter((name) => name !== ".git").sort();

describe.skipIf(!hasGit)("带回主目录：只改了大小写的改名、符号链接、撤销、带不回来的东西", () => {
  const apply = (target: TaskTarget, conflicts?: "markers") =>
    createIntegrator().integrate(target, { threadId: "t1", action: "apply", ...(conflicts != null ? { conflicts } : {}) });
  const conflictsOf = (failure: unknown) => (failure as { details: { conflicts: ApplyConflict[] } }).details.conflicts;

  it("只改了文件名、目录名的大小写：主目录里是新名字、任务的内容，一个都不丢", async () => {
    const { project, work, target } = await taskOn({ "Readme.md": "hello\nworld\n", "Dir/a.txt": "a\n", "Dir/b.txt": "b\n" });
    await run(work, "mv", "Readme.md", "README.md");
    await writeFile(join(work, "README.md"), "hello\nWORLD\n");
    // A directory's case changes in two steps: renaming it onto itself is refused.
    await run(work, "mv", "Dir", "tmp-dir");
    await run(work, "mv", "tmp-dir", "dir");

    const result = await apply(target);
    expect(result.apply?.conflicts).toEqual([]);
    expect(await names(project)).toEqual(["README.md", "dir"]);
    expect(await names(join(project, "dir"))).toEqual(["a.txt", "b.txt"]);
    expect(await read(project, "README.md")).toBe("hello\nWORLD\n");
    expect(await read(project, "dir/a.txt")).toBe("a\n");
  });

  it("只改了大小写、你在主目录改过原来的文件：报冲突，你的改动原样留着", async () => {
    const { project, work, target } = await taskOn({ "Readme.md": "hello\n" });
    await run(work, "mv", "Readme.md", "README.md");
    await writeFile(join(project, "Readme.md"), "你改的\n");

    const failure = await apply(target).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "apply_conflict", status: 409 });
    expect(conflictsOf(failure).map((entry) => entry.path)).toContain("Readme.md");

    const partial = await apply(target, "markers");
    expect(partial.apply?.conflicts.map((entry) => entry.path)).toContain("Readme.md");
    // Whether or not the disk tells the two names apart, the user's edit is still there under theirs.
    expect(await names(project)).toContain("Readme.md");
    expect(await read(project, "Readme.md")).toBe("你改的\n");
  });

  it("撤销只改了大小写的带回：原来的名字和内容都回来", async () => {
    const { project, work, target } = await taskOn({ "Readme.md": "hello\nworld\n" });
    await run(work, "mv", "Readme.md", "README.md");
    await writeFile(join(work, "README.md"), "hello\nWORLD\n");
    const integrator = createIntegrator();

    const applied = await integrator.integrate(target, { threadId: "t1", action: "apply" });
    await integrator.integrate(target, { threadId: "t1", action: "undo-apply", applyUndo: applied.applyUndo as ApplyUndoRecord });

    expect(await names(project)).toEqual(["Readme.md"]);
    expect(await read(project, "Readme.md")).toBe("hello\nworld\n");
  });

  it("你把一个目录换成了指向仓库外的符号链接：任务在里面删的、改的都不顺着它过去", async () => {
    const { project, work, target } = await taskOn({ "vendor/lib/x.js": "x\n", "vendor/lib/y.js": "y\n", "keep.txt": "k\n" });
    const outside = await tempDir();
    await writeFile(join(outside, "x.js"), "x\n");
    await writeFile(join(outside, "y.js"), "y\n");
    await rm(join(project, "vendor/lib"), { recursive: true });
    await symlink(outside, join(project, "vendor/lib"));
    await rm(join(work, "vendor/lib/x.js"));
    await writeFile(join(work, "vendor/lib/y.js"), "任务改的\n");
    await writeFile(join(work, "keep.txt"), "任务改的\n");

    const reason = "主目录里 vendor/lib 是个符号链接，不顺着它改";
    const failure = await apply(target).catch((error: unknown) => error);
    expect(conflictsOf(failure)).toEqual([
      { path: "vendor/lib/x.js", resolution: "skipped", reason },
      { path: "vendor/lib/y.js", resolution: "skipped", reason },
    ]);

    const partial = await apply(target, "markers");
    expect(partial.apply?.applied).toEqual(["keep.txt"]);
    expect(await read(outside, "x.js")).toBe("x\n");
    expect(await read(outside, "y.js")).toBe("y\n");
    expect((await lstat(join(project, "vendor/lib"))).isSymbolicLink()).toBe(true);
  });

  it("撤销带回：带回删掉的路径上你后来建了目录，目录原样留着，算你改过的；撤销前先留底", async () => {
    const { project, work, target } = await taskOn({ config: "old\n", "keep.txt": "k\n" });
    await rm(join(work, "config"));
    await writeFile(join(work, "new.txt"), "n\n");
    const integrator = createIntegrator();
    const applied = await integrator.integrate(target, { threadId: "t1", action: "apply" });

    await mkdir(join(project, "config"));
    await writeFile(join(project, "config", "mine.txt"), "你之后建的\n");
    const undone = await integrator.integrate(target, { threadId: "t1", action: "undo-apply", applyUndo: applied.applyUndo as ApplyUndoRecord });

    expect(undone.undo).toEqual({ restored: ["new.txt"], kept: ["config"] });
    expect(await read(project, "config/mine.txt")).toBe("你之后建的\n");
    expect(await missing(project, "new.txt")).toBe(true);
    const safety = (await run(project, "for-each-ref", "--format=%(refname)", "--", "refs/vgent/checkpoints/t1/apply/")).stdout
      .split("\n")
      .filter((ref) => /\/undo-\d+$/.test(ref));
    expect(safety).toHaveLength(1);
    expect((await run(project, "show", `${safety[0]}:new.txt`)).stdout).toBe("n\n");
  });

  it("任务目录里 git init 了个还没提交过的仓库：报出来，不悄悄丢下", async () => {
    const { work, target } = await taskOn({ "keep.txt": "k\n" });
    await writeFile(join(work, "keep.txt"), "任务改的\n");
    await mkdir(join(work, "newpkg"));
    await run(join(work, "newpkg"), "init", "-q");
    await writeFile(join(work, "newpkg", "index.js"), "x\n");

    const skipped: ApplyConflict = { path: "newpkg", resolution: "skipped", reason: "这是个还没有提交过的 git 仓库，带不回来" };
    const failure = await apply(target).catch((error: unknown) => error);
    expect(conflictsOf(failure)).toEqual([skipped]);
    expect((await apply(target, "markers")).apply).toEqual({ applied: ["keep.txt"], conflicts: [skipped] });
  });
});
