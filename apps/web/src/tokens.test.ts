import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(src, "../../..");

/** The two review rules from `docs/prototype/README.md`, as a test. */
const RAW_VALUE = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(/;
const RAW_SCALE = /--(?:neutral|amber|green|yellow|red|blue)-\d/;

async function walk(dir: string, skip: readonly string[]): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (skip.some((prefix) => full.startsWith(join(src, prefix)))) continue;
    if (entry.isDirectory()) files.push(...(await walk(full, skip)));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) files.push(full);
  }
  return files;
}

describe("design tokens", () => {
  it("apps/web/src/tokens.css is a verbatim copy of the prototype's", async () => {
    const [ours, prototype] = await Promise.all([
      readFile(join(src, "tokens.css"), "utf8"),
      readFile(join(repoRoot, "docs/prototype/tokens.css"), "utf8"),
    ]);
    expect(ours).toBe(prototype);
  });

  it("no component writes a raw colour or reaches for the raw scale", async () => {
    // Fetched AI Elements / shadcn sources are registry content, not ours.
    const files = await walk(src, ["components/ai-elements", "components/ui"]);
    const offenders = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      if (RAW_VALUE.test(content) || RAW_SCALE.test(content)) offenders.push(file.slice(src.length));
    }
    expect(offenders).toEqual([]);
  });
});
