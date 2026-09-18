import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryTool } from "./memory.js";

// Minimal fixture for ToolExecutionOptions; execute below never reads it.
const execOptions = { toolCallId: "t1", messages: [] } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

let memoryDir: string;

beforeEach(async () => {
  memoryDir = join(await mkdtemp(join(tmpdir(), "vgent-memory-")), "memory");
});

describe("createMemoryTool", () => {
  it("writes, lists with a one-line summary, reads back and deletes", async () => {
    const memory = createMemoryTool(memoryDir);
    const run = (input: unknown) => memory.execute!(input as never, execOptions) as Promise<string>;

    // A missing directory is an empty memory, not an error.
    expect(await run({ action: "list" })).toBe("记忆为空。");

    // The `.md` suffix is appended for the model.
    expect(await run({ action: "write", name: "build-command", content: "构建用 pnpm build。\n细节：turbo 驱动。" })).toBe(
      "已写入记忆 build-command.md",
    );

    const listing = await run({ action: "list" });
    expect(listing).toContain("build-command.md：构建用 pnpm build。");
    expect(listing).not.toContain("turbo");

    expect(await run({ action: "read", name: "build-command.md" })).toContain("turbo 驱动");
    expect(await run({ action: "read", name: "没写过" })).toBe("记忆条目不存在: 没写过.md");

    expect(await run({ action: "delete", name: "build-command" })).toBe("已删除记忆 build-command.md");
    expect(await run({ action: "list" })).toBe("记忆为空。");
  });

  it("refuses a name that would escape the memory directory", async () => {
    const memory = createMemoryTool(memoryDir);
    const result = (await memory.execute!({ action: "write", name: "../x", content: "坏" } as never, execOptions)) as string;
    expect(result).toContain("name 不合法");
    expect(await (memory.execute!({ action: "list" } as never, execOptions) as Promise<string>)).toBe("记忆为空。");
  });
});
