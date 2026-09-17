import { tool } from "ai";
import { z } from "zod";
import type { FileSystemLike } from "../fs.js";

export interface WriteToolDeps {
  fs: FileSystemLike;
  /** Resolves and validates the path, creating (and re-validating) parent directories on disk as needed. */
  resolvePath: (filePath: string) => Promise<string>;
}

export function createWriteTool({ fs, resolvePath }: WriteToolDeps) {
  return tool({
    description:
      "Write content to a file in the working directory, overwriting it if it exists and creating parent " +
      "directories if needed. Prefer `edit` for small changes to an existing file.",
    inputSchema: z.object({
      file_path: z.string().min(1).describe("Path to the file to write. Absolute, or relative to the working directory."),
      content: z.string().describe("The full content to write to the file."),
    }),
    outputSchema: z.object({
      path: z.string().describe("The resolved absolute path that was written."),
      bytes: z.number().describe("Number of UTF-8 bytes written."),
      created: z.boolean().describe("True when the file did not exist before this write."),
    }),
    execute: async ({ file_path, content }) => {
      const resolved = await resolvePath(file_path);
      const { created } = await fs.writeTextFile(resolved, content);
      return { path: resolved, bytes: Buffer.byteLength(content, "utf8"), created };
    },
  });
}
