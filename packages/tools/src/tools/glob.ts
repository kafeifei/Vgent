import { tool } from "ai";
import { relative, sep } from "node:path";
import { z } from "zod";
import { walkEntries } from "../walk.js";

const MAX_RESULTS = 500;

export interface GlobToolDeps {
  workDir: string;
  /** Resolves and validates a search root against the working directory. */
  resolveDir: (path: string) => Promise<string>;
}

export function createGlobTool({ workDir, resolveDir }: GlobToolDeps) {
  return tool({
    description:
      "Find files and directories under the working directory matching a glob pattern, e.g. '**/*.ts'. " +
      "Directories are included and end with a trailing '/' so they can be told apart from files. " +
      "Skips .git and node_modules. Returns up to 500 sorted paths, relative to the working directory.",
    inputSchema: z.object({
      pattern: z.string().min(1).describe("Glob pattern to match, e.g. '**/*.ts' or 'src/**/*.test.ts'."),
      path: z.string().optional().describe("Directory to search under, relative to the working directory. Defaults to the working directory root."),
    }),
    outputSchema: z.object({
      paths: z.array(z.string()).describe("Matched paths, relative to the working directory, sorted alphabetically."),
      truncated: z.boolean().describe("True when there were more than 500 matches; only the first 500 are returned."),
    }),
    execute: async ({ pattern, path }) => {
      const root = path ? await resolveDir(path) : workDir;
      const matches: string[] = [];
      for await (const entry of walkEntries(root, pattern)) {
        const rel = relative(workDir, entry.path).split(sep).join("/");
        matches.push(entry.isDirectory ? `${rel}/` : rel);
      }
      matches.sort();
      const truncated = matches.length > MAX_RESULTS;
      return { paths: matches.slice(0, MAX_RESULTS), truncated };
    },
  });
}
