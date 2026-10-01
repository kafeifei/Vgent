/**
 * The user's and the project's standing instructions, from `AGENTS.md` only:
 * the cross-agent `~/.agents/AGENTS.md` globally, and the repository's own.
 * Project rules are tracked in git, so a worktree carries them itself. The
 * in-house engine and Claude Code (which reads no `AGENTS.md` itself) get them
 * from here; Codex reads the same two files on its own.
 *
 * Unlike skills these are inlined: they are short, and they apply to every turn.
 */
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, join, sep } from "node:path";

/** Per file. An instructions file far past this is not something to paste into every prompt. */
const FILE_MAX_CHARS = 32_000;

const FILE_NAME = "AGENTS.md";

export interface AgentInstructionsOptions {
  /** The directory the agent works in — a worktree, or the project itself. */
  repoPath: string;
  /** Where the global file lives. Defaults to the user's home directory. */
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

/** The global file first, then the project's, so the project's reads as the more specific rule. */
export async function loadAgentInstructions({ repoPath, home = homedir() }: AgentInstructionsOptions): Promise<AgentInstructionsFile[]> {
  const files = [await readIfAny(join(home, ".agents", FILE_NAME)), await readIfAny(join(repoPath, FILE_NAME))];
  return files.filter((file): file is AgentInstructionsFile => file != null);
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

/** Rules are loaded only for an accessed path, root to leaf. */
export async function loadScopedInstructions(repoPath: string, files: readonly string[]): Promise<AgentInstructionsFile[]> {
  repoPath = await realpath(repoPath);
  const directories = new Set<string>();
  for (const accessed of files) {
    // Both sides resolved, or a symlinked prefix (macOS `/var` → `/private/var`) puts every file outside.
    const file = await realpath(accessed).catch(() => accessed);
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
    const rule = await readIfAny(join(dir, FILE_NAME));
    if (rule) result.push({ ...rule, scope: dir });
  }
  return result;
}
