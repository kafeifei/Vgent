#!/usr/bin/env node
/**
 * Pulls AI Elements (and the shadcn primitives they import) straight from the
 * official registries — the interactive `ai-elements` CLI is not used, so the
 * acquisition is reproducible and auditable.
 *
 *   node apps/web/scripts/fetch-ai-elements.mjs [--check]
 *
 * Components land in `src/components/ai-elements/` and `src/components/ui/`,
 * and `src/components/ai-elements/provenance.json` records every URL, its
 * registry-JSON sha256 and the local patches we had to apply. `--check`
 * re-fetches and reports drift instead of writing.
 *
 * The written sources are committed: AI Elements is source-distributed by
 * design, exactly like shadcn.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const ELEMENTS_DIR = join(webRoot, "src/components/ai-elements");
const UI_DIR = join(webRoot, "src/components/ui");
const PROVENANCE = join(ELEMENTS_DIR, "provenance.json");

const ELEMENTS_URL = (name) => `https://elements.ai-sdk.dev/api/registry/${name}.json`;
const SHADCN_URL = (name) => `https://ui.shadcn.com/r/styles/new-york-v4/${name}.json`;

/**
 * The elements the workbench actually renders. The chat log itself is ours
 * (`features/worklog`), so `conversation` / `message` / `reasoning` / `tool` /
 * `confirmation` are not fetched: nothing imports them, and a fetched but
 * unreferenced source is dead code (`manifest.test.ts` fails on it).
 */
const ELEMENTS = ["code-block", "shimmer", "image", "queue", "context"];

/**
 * shadcn primitives the workbench uses on its own, not through an element:
 * `dialog` is the overlay a picture in the log opens into, `context-menu` what
 * a right click on that picture offers.
 */
const UI_EXTRA = ["dialog", "context-menu"];

const check = process.argv.includes("--check");

/** Every patch we apply to registry content, so provenance can list them. */
const PATCHES = [
  {
    id: "cn-import",
    why: 'shadcn ships `import { cn } from "cn"`, a registry placeholder for the host project\'s helper.',
    apply: (source) => source.replaceAll(/from ["']cn["']/g, 'from "@/lib/utils"'),
  },
  {
    id: "registry-alias",
    why: "Registry sources import siblings through `@/registry/<style>/ui/*`; ours live in `@/components/ui/*`.",
    apply: (source) => source.replaceAll(/@\/registry\/[a-z0-9-]+\/ui\//g, "@/components/ui/"),
  },
  {
    id: "react-namespace-import",
    why: "Some new-york-v4 files use `React.ComponentProps` without importing React, which `verbatimModuleSyntax` rejects.",
    apply: (source) => {
      if (!/\bReact\./.test(source) || /^import \* as React from "react"/m.test(source)) return source;
      // Keep a leading `"use client"` first: it has to stay a directive prologue.
      const directive = /^("use client";?\n)/.exec(source);
      const head = directive?.[1] ?? "";
      return `${head}import * as React from "react";\n${source.slice(head.length)}`;
    },
  },
  {
    id: "exact-optional-shimmer",
    only: "shimmer.tsx",
    why: "shimmer.tsx casts its style object to React's `CSSProperties`, which motion's `MotionStyle` rejects under `exactOptionalPropertyTypes`; the import the cast leaves unused goes too (`noUnusedLocals`).",
    apply: (source) => {
      const cast = source.replace("} as CSSProperties\n", '} as NonNullable<MotionProps["style"]>\n');
      return cast === source ? source : cast.replace('import type { CSSProperties, ElementType, JSX } from "react";', 'import type { ElementType, JSX } from "react";');
    },
  },
  {
    id: "v7-usage-details",
    only: "context.tsx",
    why: "context.tsx reads v5's flat `usage.reasoningTokens` / `usage.cachedInputTokens`; AI SDK v7 moved them into `outputTokenDetails` / `inputTokenDetails`.",
    apply: (source) =>
      source
        .replaceAll("usage?.reasoningTokens", "usage?.outputTokenDetails.reasoningTokens")
        .replaceAll("usage?.cachedInputTokens", "usage?.inputTokenDetails.cacheReadTokens"),
  },
  {
    id: "exact-optional-context",
    only: "context.tsx",
    why: "context.tsx rebuilds its schema from destructured, possibly-undefined `usage` / `modelId`, which `exactOptionalPropertyTypes` rejects for set-or-absent fields.",
    apply: (source) =>
      source.replace("  usage?: LanguageModelUsage;\n  modelId?: ModelId;\n", "  usage?: LanguageModelUsage | undefined;\n  modelId?: ModelId | undefined;\n"),
  },
  {
    id: "image-frame-props",
    only: "image.tsx",
    why: "An SVG's own aspect has to reach the `<img>` (width, height, style) so its box exists before the drawing decodes; the registry's `ImageProps` has no such props.",
    apply: (source) =>
      source
        .replace('import { cn } from "@/lib/utils";', 'import type { CSSProperties } from "react";\nimport { cn } from "@/lib/utils";')
        .replace(
          "  alt?: string;\n};",
          "  alt?: string;\n  /** The drawing's own aspect, so an SVG reserves its box before it decodes. */\n  width?: number;\n  height?: number;\n  style?: CSSProperties;\n};",
        ),
  },
  {
    id: "exact-optional-context-menu",
    only: "context-menu.tsx",
    why: "context-menu.tsx passes a destructured, possibly-undefined `checked` back to Radix, whose prop is set-or-absent under `exactOptionalPropertyTypes`.",
    apply: (source) => source.replace("      checked={checked}\n", "      {...(checked === undefined ? {} : { checked })}\n"),
  },
];

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  const text = await response.text();
  return { json: JSON.parse(text), sha256: sha256(text) };
}

/** `registryDependencies` entries are either a bare shadcn name or a full URL. */
const resolveDependency = (entry) =>
  entry.startsWith("http")
    ? { url: entry, kind: "ai-elements", name: entry.split("/").pop().replace(/\.json$/, "") }
    : { url: SHADCN_URL(entry), kind: "shadcn", name: entry };

async function main() {
  /** url → { name, kind, url, sha256, dependencies, files } */
  const fetched = new Map();
  const npmDependencies = new Set();
  const queue = [
    ...ELEMENTS.map((name) => ({ url: ELEMENTS_URL(name), kind: "ai-elements", name })),
    ...UI_EXTRA.map((name) => ({ url: SHADCN_URL(name), kind: "shadcn", name })),
  ];

  while (queue.length > 0) {
    const item = queue.shift();
    if (fetched.has(item.url)) continue;
    const { json, sha256: digest } = await fetchJson(item.url);

    const files = [];
    for (const file of json.files ?? []) {
      const patches = [];
      let content = file.content;
      for (const patch of PATCHES) {
        if (patch.only != null && !file.path.endsWith(patch.only)) continue;
        const next = patch.apply(content);
        if (next !== content) patches.push(patch.id);
        content = next;
      }
      const base = file.path.split("/").pop();
      files.push({
        registryPath: file.path,
        localPath: join(item.kind === "shadcn" ? UI_DIR : ELEMENTS_DIR, base),
        content,
        sha256: sha256(content),
        patches,
      });
    }

    for (const dependency of json.dependencies ?? []) {
      // "cn" is the registry's placeholder for the host `cn` helper, not a package.
      if (dependency !== "cn") npmDependencies.add(dependency);
    }
    fetched.set(item.url, { ...item, sha256: digest, files });
    for (const entry of json.registryDependencies ?? []) queue.push(resolveDependency(entry));
  }

  const fetchedAt = new Date().toISOString();
  const entries = [...fetched.values()].sort((a, b) => a.name.localeCompare(b.name));

  if (check) {
    let drift = 0;
    for (const entry of entries) {
      for (const file of entry.files) {
        const existing = await readFile(file.localPath, "utf8").catch(() => undefined);
        if (existing !== file.content) {
          drift += 1;
          console.error(`漂移: ${file.localPath}`);
        }
      }
    }
    console.log(drift === 0 ? "所有 AI Elements 源码与注册表一致" : `${drift} 个文件与注册表不一致`);
    process.exitCode = drift === 0 ? 0 : 1;
    return;
  }

  await mkdir(ELEMENTS_DIR, { recursive: true });
  await mkdir(UI_DIR, { recursive: true });
  for (const entry of entries) {
    for (const file of entry.files) await writeFile(file.localPath, file.content);
  }

  const provenance = {
    note: "Fetched from the official registries by scripts/fetch-ai-elements.mjs. Only what the workbench renders is fetched; the chat log itself is ours (features/worklog).",
    fetchedAt,
    patches: PATCHES.map(({ id, why }) => ({ id, why })),
    npmDependencies: [...npmDependencies].sort(),
    items: entries.map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      url: entry.url,
      sha256: entry.sha256,
      files: entry.files.map((file) => ({
        registryPath: file.registryPath,
        localPath: file.localPath.slice(webRoot.length + 1),
        sha256: file.sha256,
        patches: file.patches,
      })),
    })),
  };
  await writeFile(PROVENANCE, `${JSON.stringify(provenance, null, 2)}\n`);

  console.log(`写入 ${entries.reduce((n, entry) => n + entry.files.length, 0)} 个文件`);
  console.log(`npm 依赖: ${[...npmDependencies].sort().join(", ")}`);
}

await main();
