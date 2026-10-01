import { tool } from "ai";
import { execFile } from "node:child_process";
import { lstat, realpath, stat as fsStat, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { z } from "zod";
import { isInside, walkFiles } from "../walk.js";

const DEFAULT_MAX_RESULTS = 200;
const MAX_GREP_FILE_BYTES = 4 * 1024 * 1024;

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

// Cached across calls within the process, per the "check once" requirement. `preferRg: false`
// bypasses this entirely so tests can force the pure-Node fallback deterministically.
let rgAvailableCache: Promise<boolean> | undefined;
function isRgAvailable(): Promise<boolean> {
  rgAvailableCache ??= new Promise((resolvePromise) => {
    execFile("rg", ["--version"], (error) => resolvePromise(!error));
  });
  return rgAvailableCache;
}

/** `execFile`'s error carries the child's numeric exit code as `code`, not `NodeJS.ErrnoException`'s string errno. */
type ExecFileError = Error & { code?: number | string };

function runRipgrep(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("rg", args as string[], { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        // ripgrep exits 1 when the search completed with no matches; that's success, not failure.
        if ((error as ExecFileError).code === 1) {
          resolvePromise("");
          return;
        }
        reject(error);
        return;
      }
      resolvePromise(stdout);
    });
  });
}

function parseRipgrepLine(line: string): GrepMatch | null {
  const match = /^(.*?):(\d+):(.*)$/.exec(line);
  if (!match) return null;
  const [, file, lineNo, text] = match;
  return { file: file!.split(sep).join("/"), line: Number(lineNo), text: text! };
}

async function grepWalk(root: string, workDir: string, pattern: RegExp, globPattern: string | undefined, limit: number): Promise<GrepMatch[]> {
  const matches: GrepMatch[] = [];
  // A symlink inside the tree can point anywhere. `read` refuses those, so this
  // walk must not read through one either: only files whose real path stays
  // under the search root are opened.
  const realRoot = await realpath(root);
  // A directory is resolved once for all the files in it; a file only costs a
  // `lstat`, and a full `realpath` only when it turns out to be a link itself.
  const realDirs = new Map<string, Promise<string | null>>();
  const realDirOf = (dir: string): Promise<string | null> => {
    let known = realDirs.get(dir);
    if (known == null) {
      known = realpath(dir).then((real) => (isInside(realRoot, real) ? real : null), () => null);
      realDirs.set(dir, known);
    }
    return known;
  };
  /** Where the file really is, or null when that is not under the search root. */
  const resolveInside = async (absPath: string): Promise<string | null> => {
    const dir = await realDirOf(dirname(absPath));
    if (dir == null) return null;
    const candidate = join(dir, basename(absPath));
    if (!(await lstat(candidate)).isSymbolicLink()) return candidate;
    const real = await realpath(candidate);
    return isInside(realRoot, real) ? real : null;
  };
  for await (const absPath of walkFiles(root, globPattern ?? "**/*")) {
    if (matches.length >= limit) break;
    let content: string;
    try {
      const real = await resolveInside(absPath);
      if (real == null) continue;
      const info = await fsStat(real);
      if (!info.isFile() || info.size > MAX_GREP_FILE_BYTES) continue;
      content = await readFile(real, "utf8");
    } catch {
      continue; // Unreadable, disappeared mid-walk, or not valid UTF-8.
    }
    if (content.includes("\0")) continue; // Skip binaries.
    const lines = content.split("\n");
    for (let i = 0; i < lines.length && matches.length < limit; i++) {
      const line = lines[i]!;
      if (pattern.test(line)) matches.push({ file: relative(workDir, absPath).split(sep).join("/"), line: i + 1, text: line });
    }
  }
  return matches;
}

export interface GrepToolDeps {
  workDir: string;
  resolveDir: (path: string) => Promise<string>;
  /** When false, always use the pure-Node walker even if ripgrep is on PATH. Defaults to true. */
  preferRg: boolean;
}

export function createGrepTool({ workDir, resolveDir, preferRg }: GrepToolDeps) {
  return tool({
    description:
      "Search file contents for a regular expression pattern. Uses ripgrep when it is available on PATH, " +
      "otherwise falls back to a built-in search. Skips .git and node_modules by default.",
    inputSchema: z.object({
      pattern: z.string().min(1).describe("Regular expression to search for."),
      path: z.string().optional().describe("Directory or file to search, relative to the working directory. Defaults to the working directory root."),
      glob: z.string().optional().describe("Only search files matching this glob pattern, e.g. '*.ts'."),
      case_insensitive: z.boolean().optional().describe("Match case-insensitively. Defaults to false."),
      max_results: z.number().int().positive().max(2000).optional().describe("Maximum number of matches to return. Defaults to 200."),
    }),
    outputSchema: z.object({
      matches: z.array(z.object({ file: z.string(), line: z.number(), text: z.string() })),
      truncated: z.boolean().describe("True when there were more matches than max_results."),
      usedRipgrep: z.boolean().describe("True when ripgrep was used instead of the pure-Node fallback."),
    }),
    execute: async ({ pattern, path, glob: globPattern, case_insensitive, max_results }) => {
      const root = path ? await resolveDir(path) : workDir;
      const maxResults = max_results ?? DEFAULT_MAX_RESULTS;
      const useRg = preferRg && (await isRgAvailable());

      if (useRg) {
        const args = ["--line-number", "--no-heading", "--color=never", "--glob", "!.git/**", "--glob", "!node_modules/**"];
        if (case_insensitive) args.push("-i");
        if (globPattern) args.push("-g", globPattern);
        // `--` before the path: a directory named `--pre=sh` must be searched,
        // not parsed as a ripgrep option that runs a program over every file.
        args.push("-e", pattern, "--", relative(workDir, root) || ".");

        let stdout: string;
        try {
          stdout = await runRipgrep(args, workDir);
        } catch (error) {
          throw new Error(`ripgrep failed: ${error instanceof Error ? error.message : String(error)}`);
        }

        const collected: GrepMatch[] = [];
        for (const line of stdout.split("\n")) {
          if (line === "") continue;
          const parsed = parseRipgrepLine(line);
          // rg prefixes output with "./" when the search target is "." (searching workDir itself).
          if (parsed) collected.push({ ...parsed, file: parsed.file.replace(/^\.\//, "") });
          if (collected.length > maxResults) break;
        }
        return { matches: collected.slice(0, maxResults), truncated: collected.length > maxResults, usedRipgrep: true };
      }

      let regex: RegExp;
      try {
        regex = new RegExp(pattern, case_insensitive ? "i" : "");
      } catch (error) {
        throw new Error(`Invalid pattern: ${error instanceof Error ? error.message : String(error)}`);
      }
      const collected = await grepWalk(root, workDir, regex, globPattern, maxResults + 1);
      return { matches: collected.slice(0, maxResults), truncated: collected.length > maxResults, usedRipgrep: false };
    },
  });
}
