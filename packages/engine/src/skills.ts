/**
 * The skills index: names and one-line descriptions only.
 *
 * A skill is a `SKILL.md` under `<dir>/<skill-name>/`. Only its frontmatter
 * reaches the system prompt — the body is a file the model can `read` when it
 * decides the skill applies. That is the whole mechanism: an index costs a line
 * per skill, the instructions cost nothing until they are needed.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Header bytes read per skill. Frontmatter lives at the very top. */
const FRONTMATTER_MAX_CHARS = 4000;

export interface SkillSummary {
  /** The skill's name — its frontmatter `name`, else its folder name. */
  name: string;
  /** One line, from the frontmatter `description`. Empty when it has none. */
  description: string;
  /** Absolute path of the `SKILL.md`, so the model can read it. */
  path: string;
}

/** Strips one layer of matching quotes from a frontmatter value. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed.startsWith('"') || trimmed.startsWith("'")) && trimmed.endsWith(trimmed[0]!)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Pulls `name` and `description` out of a `---` frontmatter block. Deliberately
 * not a YAML parser: two top-level single-line scalars is the whole contract,
 * and a dependency for that would be absurd.
 */
export function parseSkillFrontmatter(source: string): { name?: string; description?: string } {
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const result: { name?: string; description?: string } = {};
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") break;
    const match = /^(name|description)\s*:\s*(.*)$/.exec(line);
    if (match == null) continue;
    const value = unquote(match[2] ?? "");
    if (value === "") continue;
    if (match[1] === "name") result.name = value;
    else result.description = value;
  }
  return result;
}

/**
 * Indexes every `<dir>/*\/SKILL.md`. Missing or unreadable directories are
 * skipped. Earlier directories win a name collision, so a repository's own
 * skills shadow the user's global ones.
 */
export async function loadSkillsIndex(dirs: readonly string[]): Promise<SkillSummary[]> {
  const byName = new Map<string, SkillSummary>();

  for (const dir of dirs) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      // A skill installed as a symlink (a shared skills repo linked into place) is a
      // directory to whoever opens it; only `stat` follows the link where `Dirent` does not.
      if (!entry.isDirectory() && !(entry.isSymbolicLink() && (await stat(join(dir, entry.name)).catch(() => null))?.isDirectory())) continue;
      const path = join(dir, entry.name, "SKILL.md");
      const source = await readFile(path, "utf8").catch(() => undefined);
      if (source == null) continue;
      const { name, description } = parseSkillFrontmatter(source.slice(0, FRONTMATTER_MAX_CHARS));
      const resolved = name ?? entry.name;
      if (byName.has(resolved)) continue;
      byName.set(resolved, { name: resolved, description: description ?? "", path });
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
