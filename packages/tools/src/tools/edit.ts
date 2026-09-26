import { mutateFile } from "../mutations.js";
import { tool } from "ai";
import { z } from "zod";
import { buildEditDiff, type EditOccurrence } from "../diff.js";
import type { FileSystemLike } from "../fs.js";

function findOccurrences(content: string, needle: string): EditOccurrence[] {
  if (needle === "") return [];
  const occurrences: EditOccurrence[] = [];
  let from = 0;
  for (;;) {
    const index = content.indexOf(needle, from);
    if (index === -1) break;
    occurrences.push({ start: index });
    from = index + needle.length;
  }
  return occurrences;
}

function applyReplacements(content: string, occurrences: readonly EditOccurrence[], oldString: string, newString: string): string {
  let result = "";
  let cursor = 0;
  for (const { start } of occurrences) {
    result += content.slice(cursor, start) + newString;
    cursor = start + oldString.length;
  }
  return result + content.slice(cursor);
}

export interface EditToolDeps {
  fs: FileSystemLike;
  mutationScope?: object;
  resolvePath: (filePath: string) => Promise<string>;
}

export function createEditTool({ fs, resolvePath, mutationScope }: EditToolDeps) {
  return tool({
    description:
      "Replace an exact string in a file with another string. `old_string` must match exactly one location " +
      "in the file unless `replace_all` is set — include enough surrounding context in `old_string` to make " +
      "it unique. Read the file first and copy old_string exactly, including indentation. Returns a small unified diff of the change.",
    inputSchema: z.object({
      file_path: z.string().min(1).describe("Path to the file to edit. Absolute, or relative to the working directory."),
      old_string: z.string().min(1).describe("The exact text to find and replace. Must be unique in the file unless replace_all is set."),
      new_string: z.string().describe("The text to replace old_string with."),
      replace_all: z
        .boolean()
        .optional()
        .describe("Replace every occurrence of old_string instead of requiring exactly one. Defaults to false."),
    }),
    outputSchema: z.object({
      path: z.string().describe("The resolved absolute path that was edited."),
      replacements: z.number().describe("Number of occurrences replaced."),
      diff: z.string().describe("A unified-diff snippet of the change, capped at 40 lines."),
    }),
    execute: async ({ file_path, old_string, new_string, replace_all }, { abortSignal }) => {
      abortSignal?.throwIfAborted();
      const resolved = await resolvePath(file_path);
      return mutateFile(
        resolved,
        abortSignal,
        async () => {
          if ((await resolvePath(file_path)) !== resolved) throw new Error("File path changed; read it again.");
          const content = await fs.readTextFile(resolved);
          if (content === null) throw new Error(`File not found: ${file_path}`);

          const occurrences = findOccurrences(content, old_string);
          if (occurrences.length === 0) {
            throw new Error(`old_string not found in "${file_path}" (0 matches). Check the exact text, including whitespace.`);
          }
          if (occurrences.length > 1 && !replace_all) {
            throw new Error(
              `old_string is not unique in "${file_path}" (${occurrences.length} matches). ` +
                "Include more surrounding context to make it unique, or pass replace_all: true.",
            );
          }

          const applied = replace_all ? occurrences : [occurrences[0]!];
          const nextContent = applyReplacements(content, applied, old_string, new_string);
          abortSignal?.throwIfAborted();
          if ((await resolvePath(file_path)) !== resolved || (await fs.readTextFile(resolved)) !== content)
            throw new Error("File changed during edit; read it again.");
          abortSignal?.throwIfAborted();
          await fs.writeTextFile(resolved, nextContent);

          const { diff } = buildEditDiff(file_path, content, old_string, new_string, applied);
          return { path: resolved, replacements: applied.length, diff };
        },
        mutationScope,
      );
    },
  });
}
