/**
 * `@vgent/tools` — the built-in coding tool executables: `read`, `write`,
 * `edit`, `bash`, `grep`, `glob`. Their input schemas are supersets of
 * `HARNESS_V1_BUILTIN_TOOLS` (`@ai-sdk/harness`) so they interoperate with
 * that cross-harness vocabulary.
 *
 * File tools (`read`/`write`/`edit`) and `bash` run against an
 * `Experimental_SandboxSession` when one is supplied, else against the host
 * filesystem / a minimal local shell runner. `grep`/`glob` always operate on
 * the host filesystem: `Experimental_SandboxSession` has no directory-listing
 * primitive to walk, so there is nothing sandboxed to fall back to for them.
 */
import type { Experimental_SandboxSession, ToolSet } from "ai";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createNodeFileSystem, createSandboxFileSystem, type FileSystemLike } from "./fs.js";
import { createLocalRunner } from "./local-runner.js";
import { resolveToolPath, resolveWorkspacePath } from "./paths.js";
import { createBashTool, type Runner } from "./tools/bash.js";
import { createEditTool } from "./tools/edit.js";
import { createGlobTool } from "./tools/glob.js";
import { createGrepTool } from "./tools/grep.js";
import { createReadTool } from "./tools/read.js";
import { createWriteTool } from "./tools/write.js";

export { resolveToolPath, resolveWorkspacePath, type ResolvePathOptions } from "./paths.js";
export { createNodeFileSystem, createSandboxFileSystem, type FileSystemLike, type FileStat } from "./fs.js";
export { createLocalRunner, type LocalRunner, type LocalRunOptions, type LocalRunResult } from "./local-runner.js";
export { truncateKeepingEnds, type TruncatedText } from "./output.js";
export { buildEditDiff, type EditOccurrence } from "./diff.js";
export type { Runner } from "./tools/bash.js";
export type { GrepMatch } from "./tools/grep.js";

const DEFAULT_MAX_OUTPUT_CHARS = 30_000;

export interface CreateCodingToolsOptions {
  /** When provided, file tools and `bash` operate inside this sandbox instead of the host machine. */
  sandbox?: Experimental_SandboxSession;
  /** The task's working directory. All tool paths are resolved relative to (and confined to) this directory. */
  workDir: string;
  /** Cap on `bash` stdout/stderr length, keeping head and tail. Defaults to 30000. */
  maxOutputChars?: number;
  /** When false, `grep` always uses the pure-Node fallback instead of ripgrep, even if it is on PATH. Defaults to true. */
  preferRg?: boolean;
  /**
   * Directories outside `workDir` that `read` — and only `read` — may open,
   * e.g. the skills the system prompt lists by path. Host filesystem only.
   */
  readRoots?: readonly string[];
}

/**
 * Builds the built-in coding `ToolSet`: `read`, `write`, `edit`, `bash`, `grep`, `glob`.
 */
export function createCodingTools(options: CreateCodingToolsOptions): ToolSet {
  const { sandbox, workDir } = options;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const preferRg = options.preferRg ?? true;

  const fs: FileSystemLike = sandbox ? createSandboxFileSystem(sandbox) : createNodeFileSystem();
  const runner: Runner = sandbox ?? createLocalRunner(workDir);

  // Read-oriented resolution: validate the path, nothing more. Real filesystem
  // paths get the full symlink-safe walk (`resolveToolPath`); a sandbox's
  // filesystem is already isolated, so a syntactic check is enough there.
  const resolveForRead = (input: string): Promise<string> =>
    sandbox ? Promise.resolve(resolveWorkspacePath(workDir, input)) : resolveToolPath(workDir, input);

  // `read` alone also reaches the extra roots, with the same symlink-safe walk
  // against whichever root the path names.
  const readRoots = sandbox ? [] : (options.readRoots ?? []);
  const resolveForReadOnly = async (input: string): Promise<string> => {
    const target = resolve(workDir, input.startsWith("~/") ? join(homedir(), input.slice(2)) : input);
    const root = readRoots.find((dir) => target === dir || target.startsWith(`${dir}${sep}`));
    return root == null ? resolveForRead(input) : resolveToolPath(root, target);
  };

  // Write-oriented resolution additionally ensures the parent directory
  // exists and, on the real filesystem, re-validates afterwards in case a
  // symlink was planted while `mkdir` ran.
  const resolveForWrite = async (input: string): Promise<string> => {
    if (sandbox) return resolveWorkspacePath(workDir, input);
    const resolved = await resolveToolPath(workDir, input);
    await mkdir(dirname(resolved), { recursive: true });
    return resolveToolPath(workDir, input);
  };

  // grep/glob always walk the host filesystem directly (see module doc), so their
  // directory argument is validated against the real disk regardless of `sandbox`.
  const resolveHostDir = (input: string): Promise<string> => resolveToolPath(workDir, input);

  return {
    read: createReadTool({ fs, resolvePath: resolveForReadOnly }),
    write: createWriteTool({ fs, resolvePath: resolveForWrite }),
    edit: createEditTool({ fs, resolvePath: resolveForRead }),
    bash: createBashTool({ runner, workDir, resolveDir: resolveForRead, maxOutputChars }),
    grep: createGrepTool({ workDir, resolveDir: resolveHostDir, preferRg }),
    glob: createGlobTool({ workDir, resolveDir: resolveHostDir }),
  };
}
