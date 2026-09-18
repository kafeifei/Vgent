/**
 * 收口: what a finished task does with its changes.
 *
 * 提交、开 PR、带回主目录、全部丢弃, plus 撤销带回 — all of them driving the
 * real `git`, and `gh` when the machine happens to have one.
 *
 * 开 PR does not depend on `gh`: with it, a pull request is created outright;
 * without it the branch is pushed and the user is handed GitHub's own compare
 * page, which is the same thing one click later. The link that comes back is
 * stored on the thread rather than on `outcome`, because a new turn clears the
 * 收口态 and an opened PR goes on existing.
 *
 * 带回主目录 is the only action that touches the user's own checkout. It is a
 * per-file three-way merge (`apply.ts`) that never touches their index or HEAD,
 * all-or-nothing by default and 「带冲突标记合并」 on request, with the project
 * snapshotted first so it can be undone.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  partitionUndo,
  planThreeWayApply,
  runApplyPlan,
  type ApplyConflict,
  type ApplyConflictMode,
  type ApplyReport,
  type UndoApplyResult,
} from "./apply.js";
import { applyUndoScope, createCheckpoint, restoreCheckpoint, snapshotTree } from "./checkpoints.js";
import { BadRequestError, ConflictError, ExternalToolError, GitError, VgentServerError } from "./errors.js";
import { runCommand, type ToolExec } from "./exec.js";
import { EMPTY_TREE, type ChangesSnapshot, type DiffBase } from "./git.js";
import {
  silentLogger,
  type ApplyUndoRecord,
  type ChangeStats,
  type Logger,
  type Project,
  type ThreadOutcome,
  type ThreadPullRequest,
  type ThreadRecord,
} from "./types.js";

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

/**
 * Whether 开 PR is offered, and — before the user presses it — which of the
 * three routes it will take, so the button's hint can say what is about to
 * happen to their branch.
 */
export interface PrAvailability {
  available: boolean;
  /** Why not, when it is not. */
  reason?: string;
  /** `gh`: create the PR outright. `compare`: push and open GitHub's compare page. `push`: push only. */
  path?: "gh" | "compare" | "push";
  /** One line for the button's tooltip. */
  hint?: string;
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
  /** 撤销带回 is offered while the last 带回主目录's record is still on the thread. */
  canUndoApply: boolean;
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
  pr: PrAvailability;
}

/** A main-checkout task from before 任务基线 existed cannot tell its own changes from the user's. */
const NO_BASELINE_NOTE = "这个任务创建于基线功能之前，提交会包含工作目录里的全部改动";

export const INTEGRATE_ACTIONS = ["commit", "pr", "apply", "discard", "undo-apply"] as const;
export type IntegrateAction = (typeof INTEGRATE_ACTIONS)[number];

export function asIntegrateAction(value: unknown): IntegrateAction {
  if (typeof value === "string" && (INTEGRATE_ACTIONS as readonly string[]).includes(value)) return value as IntegrateAction;
  throw new BadRequestError(`action 只能是 ${INTEGRATE_ACTIONS.join(" / ")}`, "invalid_action");
}

export interface IntegrateInput {
  action: IntegrateAction;
  /** 提交 message, and the one a dirty 开 PR commits with. */
  message?: string;
  /** 带回主目录 only. `abort` (the default) leaves the checkout untouched when anything clashes. */
  conflicts?: ApplyConflictMode;
  /** The task, so 带回主目录's undo snapshot gets a ref scope of its own. */
  threadId: string;
  /** What 撤销带回 puts back — the record the last 带回主目录 left on the thread. */
  applyUndo?: ApplyUndoRecord;
}

/** Everything one 收口 action changed, for the route to write onto the thread. */
export interface IntegrateResult {
  /** The new 收口态. `null` clears it, which 撤销带回 does. */
  outcome: ThreadOutcome | null;
  /** The link 开 PR produced; a later turn never clears it. */
  pr?: ThreadPullRequest;
  /** The undo point 带回主目录 left, or `null` once 撤销带回 has consumed it. */
  applyUndo?: ApplyUndoRecord | null;
  /** 带回主目录, file by file. */
  apply?: ApplyReport;
  /** 撤销带回, file by file. */
  undo?: UndoApplyResult;
  /** One line the user has to read — today only the non-GitHub push. */
  note?: string;
}

export interface Integrator {
  status(target: TaskTarget, context?: { applyUndo?: ApplyUndoRecord }): Promise<IntegrationStatus>;
  integrate(target: TaskTarget, input: IntegrateInput): Promise<IntegrateResult>;
}

export interface CreateIntegratorOptions {
  /** Defaults to the real `execFile`; tests pass a fake for `gh` and `git push`. */
  exec?: ToolExec;
  log?: Logger;
}

/**
 * `owner/repo` out of a remote URL, but only for github.com — everything else
 * has its own idea of what a pull request URL looks like.
 *
 * Both shapes are accepted, with or without `.git`, with or without a user:
 * `git@github.com:acme/repo.git` and `https://github.com/acme/repo`.
 */
export function githubRepoFromRemote(remote: string): { owner: string; repo: string } | undefined {
  const url = remote.trim();
  if (url === "") return undefined;
  let host: string;
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    host = parsed.hostname;
    path = parsed.pathname;
  } else {
    // scp-like: `[user@]host:path`, which is not a URL at all.
    const match = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(url);
    if (match?.[1] == null || match[2] == null) return undefined;
    host = match[1];
    path = match[2];
  }
  // `ssh.github.com` is github's own alternate SSH host (port 443).
  if (!["github.com", "www.github.com", "ssh.github.com"].includes(host.toLowerCase())) return undefined;
  const parts = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "").split("/");
  if (parts.length !== 2) return undefined;
  const [owner, repo] = parts;
  if (owner == null || repo == null || owner === "" || repo === "") return undefined;
  return { owner, repo };
}

/** A branch name in a URL path: every segment escaped, the slashes left alone. */
const encodeRef = (ref: string): string => ref.split("/").map(encodeURIComponent).join("/");

/** `https://github.com/acme/repo/pull/7` → 7. */
const prNumberOf = (url: string): number | undefined => {
  const match = /\/pull\/(\d+)/.exec(url);
  const parsed = match?.[1] == null ? Number.NaN : Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** The 409's body: the whole list, so the bar can offer 「带冲突标记合并」 by name. */
function conflictMessage(conflicts: readonly ApplyConflict[]): string {
  const listed = conflicts.map((entry) => `· ${entry.path}（${entry.reason}）`).join("\n");
  return `带回主目录失败，主检出没有任何改动。\n${listed}\n可以改用「带冲突标记合并」，或手动合并。`;
}

export function createIntegrator(options: CreateIntegratorOptions = {}): Integrator {
  const exec = options.exec ?? runCommand;
  const log = options.log ?? silentLogger;

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

  /** `origin` when there is one, else whatever remote the repo does have. */
  const remoteOf = async (repoPath: string): Promise<{ name: string; url: string } | undefined> => {
    const origin = await git(repoPath, ["remote", "get-url", "origin"]);
    if (origin.code === 0 && origin.stdout.trim() !== "") return { name: "origin", url: origin.stdout.trim() };
    const names = (await git(repoPath, ["remote"])).stdout.split("\n").map((line) => line.trim());
    const first = names.find((name) => name !== "");
    if (first == null) return undefined;
    const url = await git(repoPath, ["remote", "get-url", first]);
    return url.code === 0 && url.stdout.trim() !== "" ? { name: first, url: url.stdout.trim() } : undefined;
  };

  /**
   * What the compare page should diff against: the branch the remote itself
   * calls HEAD. A clone that was never told — no `refs/remotes/<remote>/HEAD` —
   * falls back to whichever of `main` / `master` the remote has, and finally to
   * the branch the user's own checkout is sitting on.
   */
  const defaultBranchOf = async (target: TaskTarget, remote: string): Promise<string> => {
    const symref = await git(target.repoPath, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]);
    const pointed = symref.stdout.trim();
    if (symref.code === 0 && pointed !== "") return pointed.startsWith(`${remote}/`) ? pointed.slice(remote.length + 1) : pointed;
    for (const candidate of ["main", "master"]) {
      const exists = await git(target.repoPath, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${candidate}`]);
      if (exists.code === 0) return candidate;
    }
    const local = await git(target.projectPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const name = local.stdout.trim();
    return local.code === 0 && name !== "" ? name : "main";
  };

  const prAvailability = async (target: TaskTarget): Promise<PrAvailability> => {
    if (target.mode !== "worktree") return { available: false, reason: "主目录任务没有独立分支，开不了 PR" };
    const remote = await remoteOf(target.repoPath);
    if (remote == null) return { available: false, reason: "仓库没有远端，开不了 PR" };
    // `gh` is the better route when it is there — it creates the PR outright —
    // but it is no longer what decides whether the button exists at all.
    if (await ghAvailable(target.repoPath)) {
      return { available: true, path: "gh", hint: `会推送分支到 ${remote.name}，并用 gh 开 PR` };
    }
    if (githubRepoFromRemote(remote.url) != null) {
      return { available: true, path: "compare", hint: "会推送分支，并打开 GitHub 的 compare 页" };
    }
    return { available: true, path: "push", hint: `会把分支推到 ${remote.name}；这个远端不是 GitHub，PR 要到它自己的站点上开` };
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

  /**
   * 带回主目录. The plan is worked out first and written second, so 「有冲突就
   * 整体不动」 is a decision rather than a rollback, and the project is
   * snapshotted in between — a 带回 nobody can undo is not one we offer.
   */
  const apply = async (
    target: TaskTarget,
    input: { threadId: string; conflicts: ApplyConflictMode },
  ): Promise<{ report: ApplyReport; undo: ApplyUndoRecord }> => {
    const base = target.baseCommit;
    if (base == null) throw new BadRequestError("这个任务没有独立工作目录", "action_unsupported");

    // The whole working directory as a tree, built through a throwaway index so
    // the worktree's own staging area comes out of this untouched — the same
    // helper 每回合快照 uses.
    const theirs = await snapshotTree(target.repoPath, exec);
    const plan = await planThreeWayApply({
      worktreePath: target.repoPath,
      projectPath: target.projectPath,
      base,
      theirs,
      conflicts: input.conflicts,
      exec,
    });
    if (plan.steps.length === 0 && plan.conflicts.length === 0) throw new BadRequestError("没有可带回的改动", "nothing_to_apply");
    if (input.conflicts === "abort" && plan.conflicts.length > 0) {
      throw new ConflictError(conflictMessage(plan.conflicts), "apply_conflict", { conflicts: plan.conflicts });
    }

    const snapshot = await createCheckpoint({ repoPath: target.projectPath, threadId: applyUndoScope(input.threadId), log });
    if (snapshot == null) {
      throw new VgentServerError({ message: "没能给主检出打快照，已放弃带回", status: 500, code: "checkpoint_failed" });
    }
    const outcome = await runApplyPlan({ projectPath: target.projectPath, theirs, plan, exec });
    return {
      report: { applied: outcome.applied, conflicts: outcome.conflicts },
      undo: { snapshot: snapshot.commit, files: outcome.files, at: new Date().toISOString() },
    };
  };

  /**
   * 撤销带回: put back only the files whose content is still exactly what apply
   * wrote. Anything the user has touched since is theirs now, and is listed
   * rather than reverted.
   */
  const undoApply = async (target: TaskTarget, record: ApplyUndoRecord): Promise<UndoApplyResult> => {
    if ((await git(target.projectPath, ["cat-file", "-e", `${record.snapshot}^{commit}`])).code !== 0) {
      throw new ConflictError("带回之前的快照已经不在了，撤销不了", "undo_unavailable");
    }
    const split = await partitionUndo(target.projectPath, record);
    if (split.restored.length > 0) {
      await restoreCheckpoint({ repoPath: target.projectPath, commit: record.snapshot, paths: split.restored, exec, log });
    }
    return split;
  };

  const discard = async (target: TaskTarget): Promise<void> => {
    const base = target.baseCommit;
    if (base == null) throw new BadRequestError("主目录任务不提供「全部丢弃」", "action_unsupported");
    await gitOk(target.repoPath, ["reset", "--hard", base]);
    await gitOk(target.repoPath, ["clean", "-fd"]);
  };

  /** The `gh` route: reuse the branch's pull request if it has one, else create it. */
  const ghPullRequest = async (target: TaskTarget, branch: string): Promise<string> => {
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

  /**
   * 开 PR, by whichever route this machine allows. Everything up to and
   * including the push is the same either way — commit what is lying around,
   * then `git push -u` — and only the last step differs: `gh` makes the pull
   * request, and without it GitHub's compare page does, one click later.
   */
  const pullRequest = async (
    target: TaskTarget,
    message: string | undefined,
  ): Promise<{ outcome: ThreadOutcome; pr?: ThreadPullRequest; note?: string }> => {
    const branch = target.branch;
    if (branch == null) throw new BadRequestError("这个任务没有独立分支", "action_unsupported");
    const remote = await remoteOf(target.repoPath);
    if (remote == null) throw new BadRequestError("仓库没有远端，开不了 PR", "action_unsupported");
    if (await isDirty(target.repoPath)) await commit(target, message);

    const push = await exec("git", ["push", "-u", remote.name, branch], { cwd: target.repoPath, timeout: TOOL_TIMEOUT_MS });
    if (push.code !== 0) throw new ExternalToolError(`推送失败：${tail(push.stderr)}`);
    const at = new Date().toISOString();

    if (await ghAvailable(target.repoPath)) {
      const url = await ghPullRequest(target, branch);
      const number = prNumberOf(url);
      return {
        outcome: { kind: "pr", at, url },
        pr: { url, kind: "pr", branch, at, ...(number != null ? { number } : {}) },
      };
    }

    const repo = githubRepoFromRemote(remote.url);
    if (repo == null) {
      return {
        outcome: { kind: "pushed", at, ref: branch },
        note: `已推送 ${remote.name}/${branch}。这个远端不是 GitHub，PR 要到它自己的站点上开。`,
      };
    }
    const base = await defaultBranchOf(target, remote.name);
    const url = `https://github.com/${repo.owner}/${repo.repo}/compare/${encodeRef(base)}...${encodeRef(branch)}?expand=1`;
    return { outcome: { kind: "pr", at, url }, pr: { url, kind: "compare", branch, at } };
  };

  return {
    async status(target, context) {
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
        canUndoApply: context?.applyUndo != null,
        pr,
      };
    },

    async integrate(target, { action, message, conflicts, threadId, applyUndo }) {
      if (action !== "commit" && target.mode !== "worktree") {
        throw new BadRequestError("主目录任务只能提交", "action_unsupported");
      }
      const at = new Date().toISOString();
      if (action === "commit") {
        return { outcome: { kind: "committed", at, ref: await commit(target, message, await taskPaths(target)) } };
      }
      if (action === "pr") {
        const result = await pullRequest(target, message);
        return {
          outcome: result.outcome,
          ...(result.pr != null ? { pr: result.pr } : {}),
          ...(result.note != null ? { note: result.note } : {}),
        };
      }
      if (action === "apply") {
        const { report, undo } = await apply(target, { threadId, conflicts: conflicts ?? "abort" });
        return { outcome: { kind: "applied", at }, apply: report, applyUndo: undo };
      }
      if (action === "undo-apply") {
        if (applyUndo == null) throw new BadRequestError("这个任务没有可撤销的带回", "nothing_to_undo");
        // The 带回 is gone, so the task owns its diff again.
        return { outcome: null, applyUndo: null, undo: await undoApply(target, applyUndo) };
      }
      await discard(target);
      return { outcome: { kind: "discarded", at } };
    },
  };
}
