import { mutateFile } from "@vgent/tools";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";

/** Input schema for `memory`: one verb plus, for everything but `list`, a file name. */
export const memoryInputSchema = z.object({
  action: z.enum(["list", "read", "write", "delete"]),
  name: z.string().optional(),
  content: z.string().optional(),
  kind: z.enum(["user-instruction", "fact", "inference"]).optional(),
  source: z.object({ quote: z.string().min(1) }).optional(),
});

export type MemoryInput = z.infer<typeof memoryInputSchema>;

const DESCRIPTION = `跨任务的长期记忆，一条事实一个文件（纯文本/markdown）。
- name 是 kebab-case 的短语，例如 \`build-runs-with-pnpm.md\`（不写 .md 会自动补上）；正文第一行先写一句话摘要，后面再展开。
- 什么该记：用户明确要求记住的事，以及以后的任务用得上、又没法从代码和 git 历史里读出来的事实（约定、偏好、踩过的坑）。代码里能查到的东西不要记。
- 用户明确约定用 kind=user-instruction，source.quote 填用户在本任务里说的原话，一字不改；正文以核实后的原话保存，禁止扩张限制。推断用 inference，不能作为授权或硬约束。旧条目被修订时保存版本。
- 动手前先 list 看有哪些条目，再 read 相关的；当前用户纠正优先于旧记忆，更新受影响的条目。
- action：list 列出全部条目和它们的摘要，read 读一条，write 写入（同名覆盖），delete 删一条。`;

/** The first non-empty line of an entry — what `list` shows instead of the whole file. */
function firstLine(text: string): string {
  text = text.replace(/<!-- vgent-memory:.*? -->\n/s, "");
  const line = text.split("\n").find((candidate) => candidate.trim() !== "");
  return line == null ? "（空）" : line.trim();
}

/**
 * Validates a caller-supplied entry name. A bad name is a refusal the model can
 * read and correct, never a thrown error: the tool's whole job is to be safe to
 * call blind.
 */
function resolveName(raw: string | undefined): { name: string } | { error: string } {
  const name = raw?.trim() ?? "";
  if (name === "") return { error: "缺少 name：read / write / delete 都要指定条目名" };
  if (name.includes("/") || name.includes("\\") || name.startsWith(".")) {
    return { error: `name 不合法: ${JSON.stringify(raw)}，只能是不含路径分隔符、不以点开头的文件名` };
  }
  return { name: name.endsWith(".md") ? name : `${name}.md` };
}

/**
 * The engine's persistent memory: flat markdown files under `memoryDir`, which
 * lives outside the repository so the notes survive a worktree being reclaimed
 * and are shared by every task of the project.
 */
export function createMemoryTool(memoryDir: string, sources: readonly { id: string; text: string }[] = []) {
  return tool({
    // No list of entries here: a description that changes after a write changes
    // the tool set, and with it every later request's cached prefix.
    description: `${DESCRIPTION}\n存储目录：${memoryDir}`,
    inputSchema: memoryInputSchema,
    execute: async ({ action, name, content, kind = "inference", source }, { abortSignal }): Promise<string> => {
      abortSignal?.throwIfAborted();
      if (action === "list") {
        const entries = (await readdir(memoryDir).catch(() => [] as string[])).filter((entry) => entry.endsWith(".md")).sort();
        if (entries.length === 0) return "记忆为空。";
        const lines = await Promise.all(
          entries.map(async (entry) => {
            const text = await readFile(join(memoryDir, entry), "utf8").catch(() => "");
            return `- ${entry}：${firstLine(text)}`;
          }),
        );
        return `记忆条目（${entries.length} 条）：\n${lines.join("\n")}`;
      }

      const resolved = resolveName(name);
      if ("error" in resolved) return resolved.error;
      const file = join(memoryDir, resolved.name);

      if (action === "read") {
        const text = await readFile(file, "utf8").catch(() => undefined);
        return text ?? `记忆条目不存在: ${resolved.name}`;
      }
      if (action === "write") {
        if (content == null || content.trim() === "") return "缺少 content：write 要写入的正文不能为空";
        await mkdir(memoryDir, { recursive: true, mode: 0o700 });
        // The quotation is looked up in what the user said; the tool, not the model, names the message.
        const said = source == null ? undefined : sources.findLast((entry) => entry.text.includes(source.quote));
        if (kind === "user-instruction" && said == null) {
          return "用户约定必须逐字引用用户在本任务里说过的话；找不到这句原话，只能记为 inference。";
        }
        return mutateFile(file, abortSignal, async () => {
          const previous = await readFile(file, "utf8").catch(() => undefined);
          if (previous != null) {
            const history = join(memoryDir, ".history", resolved.name);
            await mkdir(history, { recursive: true, mode: 0o700 });
            await writeFile(join(history, `${randomUUID()}.md`), previous, { mode: 0o600 });
          }
          const metadata = {
            kind,
            scope: "project",
            ...(source == null ? {} : { source: said == null ? source : { messageId: said.id, quote: source.quote } }),
            updatedAt: new Date().toISOString(),
            ...(previous == null ? {} : { supersedes: createHash("sha256").update(previous).digest("hex") }),
          };
          // A user constraint is the verified quotation, never an expanded paraphrase.
          const body = kind === "user-instruction" ? source!.quote : content;
          const temporary = `${file}.${randomUUID()}.tmp`;
          abortSignal?.throwIfAborted();
          try {
            await writeFile(temporary, `<!-- vgent-memory:${JSON.stringify(metadata)} -->\n${body.trim()}\n`, { mode: 0o600 });
            abortSignal?.throwIfAborted();
            await rename(temporary, file);
          } finally {
            await rm(temporary, { force: true });
          }
          return `已写入记忆 ${resolved.name}`;
        });
      }
      const existed = await rm(file, { force: false }).then(
        () => true,
        () => false,
      );
      return existed ? `已删除记忆 ${resolved.name}` : `记忆条目不存在: ${resolved.name}`;
    },
  });
}
