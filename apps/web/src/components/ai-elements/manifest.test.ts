import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `components/ai-elements` and `components/ui` are fetched registry sources
 * (`scripts/fetch-ai-elements.mjs`). A fetched source nothing imports is dead
 * weight the next `--check` keeps carrying, so this pins three things together:
 * every vendored file is reachable from the app, the fetch script's manifest
 * names exactly what is on disk, and `provenance.json` says the same.
 */

const webRoot = fileURLToPath(new URL("../../../", import.meta.url));
const src = join(webRoot, "src");
const VENDORED = [join(src, "components/ai-elements"), join(src, "components/ui")];

const isVendored = (file: string): boolean => VENDORED.some((dir) => file.startsWith(`${dir}/`));

async function sources(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sources(full)));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(full);
  }
  return files;
}

/** Module specifiers a source imports, statically or with `import()`. */
function importsOf(text: string): string[] {
  return [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)].map((match) => match[1] as string);
}

async function resolveImport(from: string, specifier: string, known: ReadonlySet<string>): Promise<string | undefined> {
  const base = specifier.startsWith("@/") ? join(src, specifier.slice(2)) : specifier.startsWith(".") ? resolve(dirname(from), specifier) : undefined;
  if (base == null) return undefined;
  return [`${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")].find((candidate) => known.has(candidate));
}

/** What the fetch script pulls, read out of its source: `const NAME = ["a", "b"];`. */
async function listIn(script: string, name: string): Promise<string[]> {
  const body = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(script)?.[1];
  if (body == null) throw new Error(`fetch-ai-elements.mjs no longer declares ${name}`);
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);
}

interface Provenance {
  items: Array<{ name: string; kind: "ai-elements" | "shadcn"; files: Array<{ localPath: string }> }>;
}

describe("vendored AI Elements / shadcn sources", () => {
  it("are all reachable from the app: nothing fetched sits unused", async () => {
    const all = await sources(src);
    const known = new Set(all);
    const roots = all.filter((file) => !isVendored(file));
    const live = new Set<string>();
    const queue = [...roots];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      for (const specifier of importsOf(await readFile(file, "utf8"))) {
        const target = await resolveImport(file, specifier, known);
        if (target == null || live.has(target)) continue;
        live.add(target);
        queue.push(target);
      }
    }
    const orphans = all.filter((file) => isVendored(file) && !live.has(file)).map((file) => file.slice(src.length + 1));
    expect(orphans).toEqual([]);
  });

  it("are exactly what the fetch script's manifest and provenance.json list", async () => {
    const script = await readFile(join(webRoot, "scripts/fetch-ai-elements.mjs"), "utf8");
    const provenance = JSON.parse(await readFile(join(src, "components/ai-elements/provenance.json"), "utf8")) as Provenance;

    const elements = await listIn(script, "ELEMENTS");
    const shown = provenance.items.filter((item) => item.kind === "ai-elements").map((item) => item.name);
    expect(shown.sort()).toEqual([...elements].sort());

    const shadcn = provenance.items.filter((item) => item.kind === "shadcn").map((item) => item.name);
    for (const extra of await listIn(script, "UI_EXTRA")) expect(shadcn).toContain(extra);

    // Every listed file is on disk, and every file on disk is listed.
    const listed = provenance.items.flatMap((item) => item.files.map((file) => join(webRoot, file.localPath)));
    for (const file of listed) await expect(stat(file)).resolves.toBeTruthy();
    const onDisk = (await sources(src)).filter(isVendored);
    expect(onDisk.sort()).toEqual([...listed].sort());
  });
});
