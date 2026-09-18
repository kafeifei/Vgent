/**
 * 带回主目录: moving a worktree task's changes into the user's own checkout,
 * one file at a time.
 *
 * It is a three-way content merge, not a patch and not a `git merge`:
 *
 * - **base**   = the file in the 任务基线 (the commit the worktree branched from),
 * - **theirs** = the file as the task left it in its worktree,
 * - **ours**   = the file as it is right now in the project checkout.
 *
 * That is the only shape that gets the common cases right without ever touching
 * the user's index or HEAD: a file only the task changed is written straight
 * out, a file only the user changed is left alone, a file both changed is merged
 * line by line, and anything that cannot be merged is reported rather than
 * guessed at. Nothing here stages, commits or checks out — the user's own `git
 * status` reads exactly the same afterwards, bar the files that moved.
 *
 * Deciding and writing are two separate passes, which is what makes 「有冲突就
 * 整体不动」 possible at all: the whole plan exists before the first byte is
 * written. `abort` (the default) throws that plan away if a single file
 * clashed; `markers` writes it, leaving standard conflict markers in the text
 * files that clashed and skipping the ones that cannot carry markers.
 */
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { GitError } from "./errors.js";
import { runCommand, type ToolExec } from "./exec.js";
import type { ApplyUndoRecord } from "./types.js";

/** Same budget the rest of 收口 gives git. */
const GIT_TIMEOUT_MS = 60_000;

/** How many paths one `checkout-index` call takes; keeps the argv well short of its limit. */
const CHECKOUT_BATCH = 500;

/** git's own rule of thumb: a NUL byte near the start means「不是文本」. */
const BINARY_SNIFF = 8000;

/** Labels `git merge-file` writes into the conflict markers. */
const LABELS = ["你的改动", "任务基线", "任务的改动"] as const;

/** A submodule pointer: not a file, so there is nothing to carry over. */
const GITLINK = "160000";
const SYMLINK = "120000";
const EXECUTABLE = "100755";

/** What to do about a file both sides changed. */
export type ApplyConflictMode = "abort" | "markers";

/** One file 带回主目录 could not merge on its own. */
export interface ApplyConflict {
  path: string;
  /** `markers`: written with conflict markers. `skipped`: left exactly as it was. */
  resolution: "markers" | "skipped";
  /** Why, in one phrase, for the action bar. */
  reason: string;
}

/** What one 带回主目录 did, file by file. */
export interface ApplyReport {
  /** Paths written or deleted without a clash. */
  applied: string[];
  /** Paths that clashed, and what happened to each. */
  conflicts: ApplyConflict[];
}

/** A file's content as it exists on disk: bytes, or a symlink's target. */
interface Content {
  bytes: Buffer;
  link: boolean;
}

const same = (a: Content | undefined, b: Content | undefined): boolean =>
  a == null || b == null ? a == null && b == null : a.link === b.link && a.bytes.equals(b.bytes);

const isBinary = (content: Content): boolean => content.bytes.subarray(0, BINARY_SNIFF).includes(0);

/** Our own fingerprint of a file's content, for the undo record. Not a git object id — nothing looks it up. */
export const contentHash = (content: Content | undefined): string | null =>
  content == null
    ? null
    : createHash("sha256")
        .update(content.link ? `link:${content.bytes.toString()}` : content.bytes)
        .digest("hex");

/** One tree entry, out of `<mode> <type> <sha>\t<path>`. */
interface TreeEntry {
  mode: string;
  sha: string;
}

async function readContent(root: string, path: string): Promise<Content | undefined> {
  const full = resolve(root, path);
  const info = await lstat(full).catch(() => null);
  if (info == null) return undefined;
  if (info.isSymbolicLink()) return { bytes: Buffer.from(await readlink(full)), link: true };
  if (!info.isFile()) return undefined;
  return { bytes: await readFile(full), link: false };
}

/** The one thing every step here does: run git and insist it worked. */
function gitIn(repoPath: string, exec: ToolExec) {
  const run = (args: readonly string[], env?: NodeJS.ProcessEnv) =>
    exec("git", args, { cwd: repoPath, timeout: GIT_TIMEOUT_MS, ...(env != null ? { env } : {}) });
  const ok = async (args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string> => {
    const result = await run(args, env);
    if (result.code !== 0) throw new GitError(`git ${args.join(" ")} 失败: ${result.stderr.trim().slice(-500)}`);
    return result.stdout;
  };
  return { run, ok };
}

function splitNul(output: string): string[] {
  const parts = output.split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

/** `<tree>` → every path in it. `-r` so subdirectories come out as their files. */
async function listTree(repoPath: string, tree: string, exec: ToolExec): Promise<Map<string, TreeEntry>> {
  const out = await gitIn(repoPath, exec).ok(["ls-tree", "-r", "-z", tree]);
  const entries = new Map<string, TreeEntry>();
  for (const record of splitNul(out)) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode = "", , sha = ""] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (path === "" || sha === "") continue;
    entries.set(path, { mode, sha });
  }
  return entries;
}

/**
 * Write `paths` out of `tree`, through a scratch index so no real one is
 * touched. git does the writing, so binary content, executable bits and
 * symlinks all come out intact, and leading directories are created for us.
 *
 * Without `prefix` the files land in `repoPath` itself, the way a checkout
 * normally works; with one they land under that directory instead.
 */
async function checkoutTree(options: {
  repoPath: string;
  tree: string;
  paths: readonly string[];
  scratch: string;
  exec: ToolExec;
  prefix?: string;
}): Promise<void> {
  const { repoPath, tree, paths, scratch, exec, prefix } = options;
  if (paths.length === 0) return;
  const git = gitIn(repoPath, exec);
  const env = { GIT_INDEX_FILE: join(scratch, `index-${tree.slice(0, 12)}${prefix == null ? "" : "-out"}`) };
  await git.ok(["read-tree", tree], env);
  if (prefix != null) await mkdir(prefix, { recursive: true });
  // The trailing slash matters: `--prefix` is prepended verbatim.
  const args = prefix == null ? [] : [`--prefix=${prefix.endsWith("/") ? prefix : `${prefix}/`}`];
  for (let i = 0; i < paths.length; i += CHECKOUT_BATCH) {
    await git.ok(["checkout-index", "-f", ...args, "--", ...paths.slice(i, i + CHECKOUT_BATCH)], env);
  }
}

/** What the planner decided for one path. */
type Step =
  | { kind: "tree"; path: string }
  /** A merged text file, written by us — `mode` only when the task changed it. */
  | { kind: "content"; path: string; content: Buffer; mode?: number }
  | { kind: "delete"; path: string };

export interface ApplyPlan {
  steps: Step[];
  /** Paths that merged or transferred cleanly. */
  applied: string[];
  conflicts: ApplyConflict[];
}

export interface ThreeWayApplyOptions {
  /** The task's worktree — where base and theirs are read from. */
  worktreePath: string;
  /** The user's own checkout — where ours lives and where the result lands. */
  projectPath: string;
  /** 任务基线: the commit the worktree branched from. */
  base: string;
  /** The worktree's current state as a tree object (`snapshotTree`). */
  theirs: string;
  conflicts?: ApplyConflictMode;
  exec?: ToolExec;
}

/**
 * Work out what 带回主目录 would do to every file the task touched, without
 * writing anything into the user's checkout.
 */
export async function planThreeWayApply(options: ThreeWayApplyOptions): Promise<ApplyPlan> {
  const { worktreePath, projectPath, base, theirs } = options;
  const exec = options.exec ?? runCommand;
  const mode = options.conflicts ?? "abort";
  const git = gitIn(worktreePath, exec);

  // `--no-renames`, so a rename arrives as the delete and the add it really is
  // in the user's checkout — where the old path may not even be the same file.
  const changed = splitNul(await git.ok(["diff", "--name-only", "-z", "--no-renames", base, theirs]));
  const [baseTree, theirsTree] = await Promise.all([listTree(worktreePath, base, exec), listTree(worktreePath, theirs, exec)]);
  const readable = (tree: Map<string, TreeEntry>) => changed.filter((path) => tree.has(path) && tree.get(path)?.mode !== GITLINK);

  const scratch = await mkdtemp(join(tmpdir(), "vgent-3way-"));
  try {
    const baseDir = join(scratch, "base");
    const theirsDir = join(scratch, "theirs");
    await checkoutTree({ repoPath: worktreePath, tree: base, paths: readable(baseTree), scratch, exec, prefix: baseDir });
    await checkoutTree({ repoPath: worktreePath, tree: theirs, paths: readable(theirsTree), scratch, exec, prefix: theirsDir });

    const plan: ApplyPlan = { steps: [], applied: [], conflicts: [] };
    const conflict = (path: string, reason: string, resolution: ApplyConflict["resolution"] = "skipped"): void => {
      plan.conflicts.push({ path, resolution, reason });
    };

    for (const path of changed) {
      const baseEntry = baseTree.get(path);
      const theirsEntry = theirsTree.get(path);
      if (baseEntry?.mode === GITLINK || theirsEntry?.mode === GITLINK) {
        conflict(path, "子模块，带不回来");
        continue;
      }

      const ours = await readContent(projectPath, path);
      const baseContent = baseEntry == null ? undefined : await readContent(baseDir, path);
      const theirsContent = theirsEntry == null ? undefined : await readContent(theirsDir, path);

      // 任务删了它.
      if (theirsEntry == null) {
        if (ours == null) continue; // already gone from the user's checkout
        if (same(ours, baseContent)) {
          plan.steps.push({ kind: "delete", path });
          plan.applied.push(path);
        } else {
          conflict(path, "任务删了这个文件，你在主目录改过它");
        }
        continue;
      }

      // 你删了它，任务改了它 — there is no text to merge into.
      if (ours == null && baseEntry != null) {
        conflict(path, "你在主目录删了这个文件，任务改了它");
        continue;
      }
      // 任务新建的，主目录还没有: nothing of the user's to lose.
      // 主目录还没动过它: take the task's version whole, mode and all.
      if (ours == null || same(ours, baseContent)) {
        plan.steps.push({ kind: "tree", path });
        plan.applied.push(path);
        continue;
      }
      if (same(ours, theirsContent)) continue; // both sides arrived at the same place

      const special = theirsEntry.mode === SYMLINK || baseEntry?.mode === SYMLINK || ours.link;
      if (special || theirsContent == null || isBinary(ours) || isBinary(theirsContent)) {
        conflict(path, special ? "符号链接在两边都变了" : "二进制文件在两边都变了");
        continue;
      }

      const merged = await mergeFile({ scratch, ours, base: baseContent, theirs: theirsContent, exec, repoPath: worktreePath });
      // Only a mode the task itself changed is forced onto the merged file; the
      // user's own `chmod` on a file they were editing is theirs to keep.
      const modeChange = baseEntry != null && baseEntry.mode !== theirsEntry.mode ? { mode: theirsEntry.mode === EXECUTABLE ? 0o755 : 0o644 } : {};
      if (merged.clean) {
        plan.steps.push({ kind: "content", path, content: merged.content, ...modeChange });
        plan.applied.push(path);
      } else if (mode === "markers") {
        plan.steps.push({ kind: "content", path, content: merged.content, ...modeChange });
        conflict(path, "两边改了同一段，已写入冲突标记", "markers");
      } else {
        conflict(path, "两边改了同一段", "markers");
      }
    }
    return plan;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * `git merge-file` in place: it rewrites the ours copy, so the result comes
 * back as bytes rather than through a string pipe — a text file that is not
 * UTF-8 survives the round trip. A positive exit code is the number of
 * conflicts it left behind; anything outside that range is a real failure.
 */
async function mergeFile(options: {
  scratch: string;
  ours: Content;
  base: Content | undefined;
  theirs: Content;
  repoPath: string;
  exec: ToolExec;
}): Promise<{ clean: boolean; content: Buffer }> {
  const { scratch, ours, base, theirs, repoPath, exec } = options;
  const dir = join(scratch, "merge");
  await mkdir(dir, { recursive: true });
  const files = [join(dir, "ours"), join(dir, "base"), join(dir, "theirs")];
  await writeFile(files[0] as string, ours.bytes);
  // An added file has no base; an empty one makes every differing line a
  // conflict, which is exactly what「两边各自新建了同名文件」means.
  await writeFile(files[1] as string, base?.bytes ?? Buffer.alloc(0));
  await writeFile(files[2] as string, theirs.bytes);

  const args = ["merge-file", ...LABELS.flatMap((label) => ["-L", label]), ...files];
  const result = await exec("git", args, { cwd: repoPath, timeout: GIT_TIMEOUT_MS });
  if (result.code < 0 || result.code > 127) throw new GitError(`git merge-file 失败: ${result.stderr.trim().slice(-500)}`);
  return { clean: result.code === 0, content: await readFile(files[0] as string) };
}

/** Everything a finished apply left behind, ready to be recorded for 撤销. */
export interface ApplyOutcome extends ApplyReport {
  /** Each written or deleted path with the content hash apply left it at. */
  files: ApplyUndoRecord["files"];
}

/**
 * Run a plan against the user's checkout.
 *
 * Whether a conflicting plan may be run at all is the caller's decision — in
 * `abort` mode it looks at the plan and never gets here.
 */
export async function runApplyPlan(options: {
  projectPath: string;
  /** The worktree's state as a tree; `tree` steps are checked out of it. */
  theirs: string;
  plan: ApplyPlan;
  exec?: ToolExec;
}): Promise<ApplyOutcome> {
  const { projectPath, theirs, plan } = options;
  const exec = options.exec ?? runCommand;

  const treePaths = plan.steps.filter((step) => step.kind === "tree").map((step) => step.path);
  const scratch = await mkdtemp(join(tmpdir(), "vgent-apply-"));
  try {
    // Straight into the user's checkout, out of the object store the worktree
    // shares with its project, and through a scratch index — so the user's own
    // staging area never moves.
    await checkoutTree({ repoPath: projectPath, tree: theirs, paths: treePaths, scratch, exec });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  for (const step of plan.steps) {
    const full = resolve(projectPath, step.path);
    if (step.kind === "content") {
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, step.content);
      if (step.mode != null) await chmod(full, step.mode);
    } else if (step.kind === "delete") {
      await rm(full, { force: true });
    }
  }

  // Fingerprints are read back off disk rather than taken from what we meant to
  // write: what 撤销 has to recognise later is the file as it actually is.
  const files: ApplyUndoRecord["files"] = [];
  for (const step of plan.steps) {
    files.push({ path: step.path, hash: contentHash(await readContent(projectPath, step.path)) });
  }
  return { applied: plan.applied, conflicts: plan.conflicts, files };
}

/** What 撤销带回 put back, and what it deliberately did not. */
export interface UndoApplyResult {
  /** Paths restored to their pre-apply content. */
  restored: string[];
  /** Paths the user has edited since the apply, left exactly as they are. */
  kept: string[];
}

/**
 * Which of an apply's paths are still byte-for-byte what it wrote. Everything
 * else the user has been working on since, and 撤销 does not touch it.
 */
export async function partitionUndo(projectPath: string, record: ApplyUndoRecord): Promise<UndoApplyResult> {
  const restored: string[] = [];
  const kept: string[] = [];
  for (const file of record.files) {
    const current = contentHash(await readContent(projectPath, file.path));
    if (current === file.hash) restored.push(file.path);
    else kept.push(file.path);
  }
  return { restored, kept };
}
