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
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createNodeFileSystem, createSandboxFileSystem, type FileSystemLike } from "./fs.js";
import { createLocalRunner } from "./local-runner.js";
import { isInsideGitMetadata, resolveToolPath, resolveWorkspacePath } from "./paths.js";
import { createStreamingBashTool } from "./streaming-bash.js";
import type { ObservedFiles } from "./mutations.js";
import { createBashTool, type Runner } from "./tools/bash.js";
import { createEditTool } from "./tools/edit.js";
import { createGlobTool } from "./tools/glob.js";
import { createGrepTool } from "./tools/grep.js";
import { createReadTool } from "./tools/read.js";
import { createWriteTool } from "./tools/write.js";

export { mutateFile } from "./mutations.js";
export { foldFileName, isInsideGitMetadata, resolveToolPath, resolveWorkspacePath, type ResolvePathOptions } from "./paths.js";
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
  /** Default directory for file paths and commands. File access also includes the configured roots. */
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
  /** Additional explicitly configured project roots, subject to the tool approval mode. */
  writeRoots?: readonly string[];
  onRead?: (path: string) => Promise<void>;
  outputDir?: string;
}

/**
 * Builds the built-in coding `ToolSet`: `read`, `write`, `edit`, `bash`, `grep`, `glob`.
 */
export function createCodingTools(options: CreateCodingToolsOptions): ToolSet {
  const { sandbox } = options;
  const workDir = resolve(options.workDir);
  // Snapshot the effective paths once for both execution and tool descriptions.
  const roots = (paths: readonly string[]) => [...new Set(paths.map((path) => resolve(workDir, path)))];
  const fileRoots = roots([workDir, ...(sandbox ? [] : (options.writeRoots ?? []))]);
  const readRoots = roots([...fileRoots, ...(sandbox ? [] : (options.readRoots ?? [])), ...(options.outputDir && !sandbox ? [options.outputDir] : [])]);
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const preferRg = options.preferRg ?? true;

  const observed: ObservedFiles = new Map();
  const fs: FileSystemLike = sandbox ? createSandboxFileSystem(sandbox) : createNodeFileSystem();
  const runner: Runner =
    sandbox ?? createLocalRunner(workDir, options.outputDir ? { outputDir: options.outputDir, maxOutputChars } : undefined);

  // Read-oriented resolution: validate the path, nothing more. Real filesystem
  // paths get the full symlink-safe walk (`resolveToolPath`); a sandbox's
  // filesystem is already isolated, so a syntactic check is enough there.
  const resolveInRoots = async (input: string, roots: readonly string[]): Promise<string> => {
    if (sandbox) return resolveWorkspacePath(workDir, input);
    const target = resolve(workDir, input.startsWith("~/") ? join(homedir(), input.slice(2)) : input);
    let failure: unknown;
    for (const root of roots) {
      try {
        return await resolveToolPath(root, target);
      } catch (error) {
        failure = error;
      }
    }
    throw failure;
  };
  const resolveForRead = (input: string) => resolveInRoots(input, fileRoots);
  const resolveForReadOnly = (input: string) =>
    resolveInRoots(input, readRoots);

  // A write into `.git` is a way to run code: git executes the programs its
  // config and hooks name (`core.fsmonitor`, `hooks/*`), and `git status` — on
  // the built-in safe list — would run them on the next call. Refused in every
  // mode; `git config` through `bash` is the door that asks.
  const refuseGitMetadata = async (input: string, resolved: string): Promise<void> => {
    const roots = sandbox ? [workDir] : await Promise.all(fileRoots.map((root) => realpath(root).catch(() => root)));
    if (roots.some((root) => isInsideGitMetadata(root, resolved))) {
      throw new Error(
        `Refusing to modify ${JSON.stringify(input)}: it is inside a .git directory, where files decide which programs git runs. Use git commands instead.`,
      );
    }
  };

  // Write-oriented resolution additionally ensures the parent directory
  // exists and, on the real filesystem, re-validates afterwards in case a
  // symlink was planted while `mkdir` ran. The `.git` check comes before the
  // `mkdir`, so a refused path leaves nothing behind.
  const resolveForWrite = async (input: string): Promise<string> => {
    if (sandbox) {
      const resolved = resolveWorkspacePath(workDir, input);
      await refuseGitMetadata(input, resolved);
      return resolved;
    }
    const resolved = await resolveForRead(input);
    await refuseGitMetadata(input, resolved);
    await mkdir(dirname(resolved), { recursive: true });
    return resolveForRead(input);
  };
  const resolveForEdit = async (input: string): Promise<string> => {
    const resolved = await resolveForRead(input);
    await refuseGitMetadata(input, resolved);
    return resolved;
  };

  // grep/glob always walk the host filesystem directly (see module doc), so their
  // directory argument is validated against the real disk regardless of `sandbox`.
  const resolveHostDir = resolveForRead;

  const tools: ToolSet = {
    read: createReadTool({
      fs,
      resolvePath: resolveForReadOnly,
      observed,
      ...(options.onRead ? { onRead: options.onRead } : {}),
      ...(options.outputDir && !sandbox
        ? {
            allowLarge: async (path: string) => {
              try {
                await resolveToolPath(options.outputDir!, path);
                return true;
              } catch {
                return false;
              }
            },
          }
        : {}),
    }),
    write: createWriteTool({ fs, resolvePath: resolveForWrite, observed, ...(sandbox ? { mutationScope: sandbox } : {}) }),
    edit: createEditTool({ fs, resolvePath: resolveForEdit, ...(sandbox ? { mutationScope: sandbox } : {}) }),
    bash: (sandbox ? createBashTool : createStreamingBashTool)({ runner, workDir, resolveDir: resolveForRead, maxOutputChars }),
    grep: createGrepTool({ workDir, resolveDir: resolveHostDir, preferRg }),
    glob: createGlobTool({ workDir, resolveDir: resolveHostDir }),
  };
  // These descriptions are sent by the SDK with the actual selected tools.
  // Removing a tool also removes its capability claims from the model input.
  for (const [name, definition] of Object.entries(tools)) {
    const paths = name === "read" ? readRoots : fileRoots;
    const scope = name === "bash"
      ? `${sandbox ? "Shell execution uses the configured sandbox." : "Host shell with process-account permissions; cwd is not an OS sandbox."} Default cwd: ${JSON.stringify(workDir)}. Other allowed cwd roots: ${JSON.stringify(fileRoots.slice(1))}. The cwd check does not restrict command effects.`
      : `${sandbox && ["read", "write", "edit"].includes(name) ? "Sandbox" : "Host"} file access: paths resolve relative to ${JSON.stringify(workDir)} and are limited to that directory${paths.length > 1 ? ` plus ${JSON.stringify(paths.slice(1))}` : ""}.`;
    tools[name] = { ...definition, description: `${definition.description}\n${scope}` } as ToolSet[string];
  }
  return tools;
}
