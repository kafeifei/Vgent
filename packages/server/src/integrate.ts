/**
 * 收口: what a finished task does with its changes.
 *
 * Four actions, all of them driving the real `git` and `gh` — 提交、开 PR、
 * 带回主目录、全部丢弃. 带回主目录 is the only one that touches the user's own
 * checkout, so it is built to be all-or-nothing: the worktree's full state is
 * turned into a patch through a throwaway index (the worktree's real index is
 * never touched), `git apply --check` rules on it in the project, and the
 * project is written to only once that check has passed.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotTree } from "./checkpoints.js";
import { BadRequestError, ConflictError, ExternalToolError, GitError } from "./errors.js";
import { runCommand, type ToolExec } from "./exec.js";
import { EMPTY_TREE, type ChangesSnapshot, type DiffBase } from "./git.js";
import type { ChangeStats, Project, ThreadOutcome, ThreadRecord } from "./types.js";

/** Pushes and `gh` calls go over the network; give them room. */
const TOOL_TIMEOUT_MS = 60_000;
/** The availability probe must never make the panel wait. */
const GH_PROBE_TIMEOUT_MS = 5_000;
/** How long one `gh auth status` answer is reused for. */
const GH_CACHE_MS = 60_000;
const STDERR_TAIL = 500;

const tail = (text: string): string => text.trim().slice(-STDERR_TAIL) || "（没有输出）";

export type TaskMode = "project" | "worktree";

/** Where one task's files are, and what its diff is measured against. */
export interface TaskTarget {
  mode: TaskMode;
  /** The directory the task edits: its worktree, or the project checkout. */
  repoPath: string;
  /** The project's own checkout — where 带回主目录 lands. */
  projectPath: string;
  branch?: string;
  /** The commit a worktree task branched from. Absent for a main-checkout task, which has no branch of its own. */
  baseCommit?: string;
  /** 任务基线: what 改动 and 提交 are measured against. Absent = `HEAD`, the fallback of a task older than 任务基线. */
  baseline?: DiffBase;
}

/** A thread plus its project → the two directories and the baseline. Pure. */
export function taskTarget(thread: Pick<ThreadRecord, "workspace" | "baselineCommit" | "messages">, project: Project): TaskTarget {
  const workspace = thread.workspace;
  if (workspace == null) {
    // A main-checkout task's baseline is a snapshot of the working directory,
    // taken before its first turn. Until it has run one it cannot have changed
    // anything — whatever is lying around uncommitted is the user's own. Only a
    // task from before 任务基线 existed (messages, no baseline) falls back to HEAD.
    const baseline: DiffBase | undefined =
      thread.baselineCommit != null ? { tree: thread.baselineCommit } : thread.messages.length === 0 ? { none: true } : undefined;
    return {
      mode: "project",
      repoPath: project.repoPath,
      projectPath: project.repoPath,
      ...(baseline != null ? { baseline } : {}),
    };
  }
  return {
    mode: "worktree",
    repoPath: workspace.path,
    projectPath: project.repoPath,
    branch: workspace.branch,
    baseCommit: workspace.baseCommit,
    baseline: workspace.baseCommit,
  };
}

/** The 变更 snapshot summed into the three numbers the sidebar shows. */
export function changeStatsOf(snapshot: ChangesSnapshot): ChangeStats {
  let additions = 0;
  let deletions = 0;
  for (const file of snapshot.files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { files: snapshot.files.length, additions, deletions };
}

export interface IntegrationStatus {
  mode: TaskMode;
  branch?: string;
  /** Commits the task made on its own branch since its baseline. */
  commitsAhead: number;
  dirty: boolean;
  canCommit: boolean;
  canApply: boolean;
  canDiscardAll: boolean;
  /** How many files 提交 would commit. Only for a task with a 任务基线; a worktree task commits its whole directory. */
  commitFiles?: number;
  /**
   * Of those, how many the user had already edited before the task started. A
   * commit takes whole files, so those earlier uncommitted lines go in with the
   * task's — absent when there are none.
   */
  commitFilesWithOwnEdits?: number;
  /** Something the user has to know before pressing a button — today only the missing-baseline warning. */
  note?: string;
  /** 开 PR needs a worktree task, an `origin`, and a logged-in `gh`. */
  pr: { available: boolean; reason?: string };
}

/** A main-checkout task from before 任务基线 existed cannot tell its own changes from the user's. */
const NO_BASELINE_NOTE = "这个任务创建于基线功能之前，提交会包含工作目录里的全部改动";

export const INTEGRATE_ACTIONS = ["commit", "pr", "apply", "discard"] as const;
export type IntegrateAction = (typeof INTEGRATE_ACTIONS)[number];

export function asIntegrateAction(value: unknown): IntegrateAction {
  if (typeof value === "string" && (INTEGRATE_ACTIONS as readonly string[]).includes(value)) return value as IntegrateAction;
  throw new BadRequestError(`action 只能是 ${INTEGRATE_ACTIONS.join(" / ")}`, "invalid_action");
}

export interface Integrator {
  status(target: TaskTarget): Promise<IntegrationStatus>;
  integrate(target: TaskTarget, input: { action: IntegrateAction; message?: string }): Promise<ThreadOutcome>;
}

export interface CreateIntegratorOptions {
  /** Defaults to the real `execFile`; tests pass a fake for `gh` and `git push`. */
  exec?: ToolExec;
}

/** The files `git apply` named in its complaint, so the user knows where to look. */
function conflictFiles(stderr: string): string[] {
  return [...new Set([...stderr.matchAll(/^error: (?:patch failed: )?(.+?):/gm)].map((match) => match[1] ?? ""))].filter(
    (path) => path.length > 0,
  );
}

function conflictMessage(stderr: string): string {
  const files = conflictFiles(stderr);
  const listed = files.length > 0 ? `冲突文件：\n${files.map((file) => `· ${file}`).join("\n")}\n` : "";
  return `带回主目录失败，主检出没有任何改动。\n${listed}可以先在任务里提交后开 PR，或手动合并。`;
}

export function createIntegrator(options: CreateIntegratorOptions = {}): Integrator {
  const exec = options.exec ?? runCommand;

  const git = (cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv) =>
    exec("git", args, { cwd, timeout: TOOL_TIMEOUT_MS, ...(env != null ? { env } : {}) });

  /** Runs git and insists it worked. */
  const gitOk = async (cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string> => {
    const result = await git(cwd, args, env);
    if (result.code !== 0) throw new GitError(`git ${args.join(" ")} 失败: ${tail(result.stderr)}`);
    return result.stdout;
  };

  const isDirty = async (cwd: string): Promise<boolean> => (await gitOk(cwd, ["status", "--porcelain"])).trim().length > 0;

  const commitsAheadOf = async (target: TaskTarget): Promise<number> => {
    if (target.baseCommit == null) return 0;
    const result = await git(target.repoPath, ["rev-list", "--count", `${target.baseCommit}..HEAD`]);
    return result.code === 0 ? Number.parseInt(result.stdout.trim(), 10) || 0 : 0;
  };

  // `gh auth status` shells out to a program that may itself hit the network,
  // and the panel asks on every open — one answer a minute is plenty.
  let ghCheckedAt = 0;
  let ghLoggedIn = false;
  const ghAvailable = async (cwd: string): Promise<boolean> => {
    if (Date.now() - ghCheckedAt < GH_CACHE_MS) return ghLoggedIn;
    const result = await exec("gh", ["auth", "status"], { cwd, timeout: GH_PROBE_TIMEOUT_MS });
    ghLoggedIn = result.code === 0;
    ghCheckedAt = Date.now();
    return ghLoggedIn;
  };

  const prAvailability = async (target: TaskTarget): Promise<IntegrationStatus["pr"]> => {
    if (target.mode !== "worktree") return { available: false, reason: "主目录任务没有独立分支，开不了 PR" };
    if ((await git(target.repoPath, ["remote", "get-url", "origin"])).code !== 0) {
      return { available: false, reason: "仓库没有 origin 远端" };
    }
    if (!(await ghAvailable(target.repoPath))) return { available: false, reason: "没找到已登录的 gh 命令行" };
    return { available: true };
  };

  /**
   * The paths the task itself changed: 任务基线 against the working directory as
   * a tree, built through a throwaway index so the user's own is never touched.
   *
   * `undefined` means the task has no baseline to measure against — a worktree
   * task, whose whole directory is its own, or a task older than 任务基线.
   */
  const taskPaths = async (target: TaskTarget): Promise<string[] | undefined> => {
    const baseline = target.baseline;
    if (baseline == null || typeof baseline === "string") return undefined;
    if ("none" in baseline) return [];
    const current = await snapshotTree(target.repoPath, exec);
    // `--no-renames` so a rename comes out as both of its paths, which is what
    // has to be staged for the commit to carry it.
    const out = await gitOk(target.repoPath, ["diff", "--name-only", "-z", "--no-renames", baseline.tree, current]);
    const paths = out.split("\0");
    if (paths.at(-1) === "") paths.pop();
    return paths;
  };

  /**
   * Of the task's paths, the ones the user had already been editing: their
   * content in the 任务基线 is not what HEAD has (or HEAD does not have them at
   * all). A commit takes whole files, so committing those carries the user's
   * earlier uncommitted lines too, and the action bar has to say so.
   *
   * `git diff` takes no pathspec file, so the whole baseline is compared to HEAD
   * once — that is the user's uncommitted state at the moment the task started —
   * and the task's paths are looked up in it.
   */
  const ownEditCount = async (target: TaskTarget, paths: string[]): Promise<number> => {
    const baseline = target.baseline;
    if (paths.length === 0 || baseline == null || typeof baseline === "string" || "none" in baseline) return 0;
    const head = await git(target.repoPath, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    const committed = head.code === 0 && head.stdout.trim() !== "" ? "HEAD" : EMPTY_TREE;
    const out = await gitOk(target.repoPath, ["diff", "--name-only", "-z", "--no-renames", committed, baseline.tree]);
    const dirtyAtStart = new Set(out.split("\0").filter((path) => path !== ""));
    return paths.filter((path) => dirtyAtStart.has(path)).length;
  };

  /**
   * `git commit`, in whichever directory the task owns.
   *
   * `paths` — the task's own, for a main-checkout task — scopes both the staging
   * and the commit to them, so every other change in the user's checkout, staged
   * or not, is exactly where they left it afterwards. They travel through a file
   * rather than the command line: a big turn can touch more paths than an argv
   * holds.
   */
  const commit = async (target: TaskTarget, message: string | undefined, paths?: string[]): Promise<string> => {
    const text = message?.trim() ?? "";
    if (text === "") throw new BadRequestError("提交信息不能为空", "invalid_message");
    if (paths == null ? !(await isDirty(target.repoPath)) : paths.length === 0) {
      throw new BadRequestError("没有可提交的改动", "nothing_to_commit");
    }

    const scratch = paths == null ? undefined : await mkdtemp(join(tmpdir(), "vgent-commit-"));
    try {
      let scope: string[] = [];
      if (paths != null && scratch != null) {
        const listFile = join(scratch, "paths");
        await writeFile(listFile, `${paths.join("\0")}\0`);
        scope = [`--pathspec-from-file=${listFile}`, "--pathspec-file-nul"];
      }
      await gitOk(target.repoPath, ["add", "-A", ...scope]);
      const result = await git(target.repoPath, ["commit", "-m", text, ...scope]);
      // Git's own words: a missing `user.email` explains itself better than we could.
      if (result.code !== 0) throw new BadRequestError(`提交失败：${tail(result.stderr || result.stdout)}`, "commit_failed");
      return (await gitOk(target.repoPath, ["rev-parse", "HEAD"])).trim();
    } finally {
      if (scratch != null) await rm(scratch, { recursive: true, force: true });
    }
  };

  const apply = async (target: TaskTarget): Promise<void> => {
    const base = target.baseCommit;
    if (base == null) throw new BadRequestError("这个任务没有独立工作目录", "action_unsupported");

    const scratch = await mkdtemp(join(tmpdir(), "vgent-apply-"));
    try {
      // The whole working directory as a tree, built through a throwaway index
      // so the worktree's own staging area comes out of this untouched — the
      // same helper 每回合快照 uses.
      const tree = await snapshotTree(target.repoPath, exec);
      const patch = await gitOk(target.repoPath, ["diff", "--binary", base, tree]);
      if (patch.trim() === "") throw new BadRequestError("没有可带回的改动", "nothing_to_apply");

      const patchFile = join(scratch, "changes.patch");
      await writeFile(patchFile, patch);
      const check = await git(target.projectPath, ["apply", "--check", "--", patchFile]);
      if (check.code !== 0) throw new ConflictError(conflictMessage(check.stderr), "apply_conflict");
      const applied = await git(target.projectPath, ["apply", "--", patchFile]);
      if (applied.code !== 0) throw new ConflictError(conflictMessage(applied.stderr), "apply_conflict");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };

  const discard = async (target: TaskTarget): Promise<void> => {
    const base = target.baseCommit;
    if (base == null) throw new BadRequestError("主目录任务不提供「全部丢弃」", "action_unsupported");
    await gitOk(target.repoPath, ["reset", "--hard", base]);
    await gitOk(target.repoPath, ["clean", "-fd"]);
  };

  const pullRequest = async (target: TaskTarget, message: string | undefined): Promise<string> => {
    const branch = target.branch;
    if (branch == null) throw new BadRequestError("这个任务没有独立分支", "action_unsupported");
    if (await isDirty(target.repoPath)) await commit(target, message);

    const push = await exec("git", ["push", "-u", "origin", branch], { cwd: target.repoPath, timeout: TOOL_TIMEOUT_MS });
    if (push.code !== 0) throw new ExternalToolError(`推送失败：${tail(push.stderr)}`);

    const existing = await exec("gh", ["pr", "view", branch, "--json", "url"], { cwd: target.repoPath, timeout: TOOL_TIMEOUT_MS });
    if (existing.code === 0) {
      const url = (JSON.parse(existing.stdout || "{}") as { url?: unknown }).url;
      if (typeof url === "string" && url.length > 0) return url;
    }

    const created = await exec("gh", ["pr", "create", "--fill", "--head", branch], {
      cwd: target.repoPath,
      timeout: TOOL_TIMEOUT_MS,
    });
    if (created.code !== 0) throw new ExternalToolError(`开 PR 失败：${tail(created.stderr)}`);
    const url = /https?:\/\/\S+/.exec(created.stdout)?.[0];
    if (url == null) throw new ExternalToolError(`开 PR 失败：没能从 gh 的输出里读到链接`);
    return url;
  };

  return {
    async status(target) {
      const [dirty, commitsAhead, pr, paths] = await Promise.all([
        isDirty(target.repoPath),
        commitsAheadOf(target),
        prAvailability(target),
        taskPaths(target),
      ]);
      const worktree = target.mode === "worktree";
      const hasWork = dirty || commitsAhead > 0;
      const ownEdits = paths == null ? 0 : await ownEditCount(target, paths);
      return {
        mode: target.mode,
        ...(target.branch != null ? { branch: target.branch } : {}),
        commitsAhead,
        dirty,
        // A dirty repo is not the same thing as a task with changes: 提交 only
        // ever carries what this task did.
        canCommit: paths == null ? dirty : paths.length > 0,
        ...(paths != null ? { commitFiles: paths.length } : {}),
        ...(ownEdits > 0 ? { commitFilesWithOwnEdits: ownEdits } : {}),
        ...(!worktree && target.baseline == null ? { note: NO_BASELINE_NOTE } : {}),
        canApply: worktree && hasWork,
        // A main-checkout task cannot tell its own untracked files from the
        // user's, so it is never offered a blanket discard.
        canDiscardAll: worktree && hasWork,
        pr,
      };
    },

    async integrate(target, { action, message }) {
      if (action !== "commit" && target.mode !== "worktree") {
        throw new BadRequestError("主目录任务只能提交", "action_unsupported");
      }
      const at = new Date().toISOString();
      if (action === "commit") return { kind: "committed", at, ref: await commit(target, message, await taskPaths(target)) };
      if (action === "pr") return { kind: "pr", at, url: await pullRequest(target, message) };
      if (action === "apply") {
        await apply(target);
        return { kind: "applied", at };
      }
      await discard(target);
      return { kind: "discarded", at };
    },
  };
}
