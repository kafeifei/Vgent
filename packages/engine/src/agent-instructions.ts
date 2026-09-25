/**
 * The user's and the project's standing instructions: `AGENTS.md` (the Codex /
 * cross-agent convention) and `CLAUDE.md` (Claude Code's). Claude Code and
 * Codex read theirs on their own; the in-house engine read none, so every rule
 * written there — how this repo ships, which language to answer in — had to be
 * repeated by hand in each task.
 *
 * Unlike skills these are inlined: they are short, and they apply to every turn.
 */
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, join, sep } from "node:path";

/** Per file. An instructions file far past this is not something to paste into every prompt. */
const FILE_MAX_CHARS = 32_000;

const FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;

export interface AgentInstructionsOptions {
  /** The directory the agent works in — a worktree, or the project itself. */
  repoPath: string;
  /**
   * The project's own checkout when `repoPath` is a worktree cut from it. A
   * file kept out of git on purpose (a local-only `AGENTS.md`) exists only
   * there, so it is read from here when the worktree has none of that name.
   */
  projectPath?: string;
  /** Where the global files live. Defaults to the user's home directory. */
  home?: string;
}

export interface AgentInstructionsFile {
  path: string;
  content: string;
  scope?: string;
}

const readIfAny = async (path: string): Promise<AgentInstructionsFile | undefined> => {
  const source = await readFile(path, "utf8").catch(() => undefined);
  const content = source?.trim();
  if (content == null || content === "") return undefined;
  return { path, content: content.length > FILE_MAX_CHARS ? `${content.slice(0, FILE_MAX_CHARS)}\n…（截断）` : content };
};

/**
 * Global files first, then the project's, so the project's come later in the
 * prompt and read as the more specific rule. The same text reached twice (a
 * worktree and its project both tracking `CLAUDE.md`) is kept once.
 */
export async function loadAgentInstructions({
  repoPath,
  projectPath,
  home = homedir(),
}: AgentInstructionsOptions): Promise<AgentInstructionsFile[]> {
  const global = [join(home, ".agents", "AGENTS.md"), join(home, ".codex", "AGENTS.md"), join(home, ".claude", "CLAUDE.md")];
  const candidates = await Promise.all(global.map(readIfAny));
  for (const name of FILE_NAMES) {
    const own = await readIfAny(join(repoPath, name));
    candidates.push(own ?? (projectPath != null && projectPath !== repoPath ? await readIfAny(join(projectPath, name)) : undefined));
  }
  const seen = new Set<string>();
  return candidates.filter((file): file is AgentInstructionsFile => {
    if (file == null || seen.has(file.content)) return false;
    seen.add(file.content);
    return true;
  });
}

/** The system-prompt section for {@link loadAgentInstructions}' files; empty when there are none. */
export function agentInstructionsSection(files: readonly AgentInstructionsFile[]): string {
  if (files.length === 0) return "";
  const body = files
    .map((file) => `<instructions path="${file.path}"${file.scope ? ` scope="${file.scope}"` : ""}>\n${file.content}\n</instructions>`)
    .join("\n\n");
  return `Standing instructions from the user and this project. Follow them as you would the user's own words; where
they conflict within the same path scope, the more specific file wins (sibling directory rules apply only inside their own directories), and anything the user says in this conversation wins over all of them.

${body}`;
}

/** Rules are loaded only for an accessed path, root to leaf, on every following step. */
export async function loadScopedInstructions(repoPath: string, files: readonly string[]): Promise<AgentInstructionsFile[]> {
  repoPath = await realpath(repoPath);
  const directories = new Set<string>();
  for (const file of files) {
    const rel = relative(repoPath, file);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) continue;
    let dir = dirname(file);
    while (dir !== resolve(repoPath)) {
      directories.add(dir);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const result: AgentInstructionsFile[] = [];
  for (const dir of [...directories].sort((a, b) => a.split(sep).length - b.split(sep).length || a.localeCompare(b))) {
    for (const name of FILE_NAMES) {
      const rule = await readIfAny(join(dir, name));
      if (rule) result.push({ ...rule, scope: dir });
    }
  }
  return result;
}
