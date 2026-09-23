import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { exploreCounts, exploreLabel, shellExploreKind } from "./explore";
import { buildTurns, type Block } from "./turns";

const tool = (id: string, name: string, input: Record<string, unknown>, state = "output-available") =>
  ({ type: `tool-${name}`, toolCallId: id, state, input }) as unknown as UIMessage["parts"][number];

const toolBlocks = (parts: UIMessage["parts"]) =>
  (buildTurns([
    { id: "u", role: "user", parts: [{ type: "text", text: "问" }] },
    { id: "a", role: "assistant", parts },
  ])[0]?.blocks ?? []).filter((block): block is Extract<Block, { kind: "tool" }> => block.kind === "tool");

describe("shellExploreKind", () => {
  it("sees a read, a search and a listing through cd, pipes and quotes", () => {
    expect(shellExploreKind("cd /Users/me/Codes/Vgent; sed -n 100,140p packages/server/src/app.ts")).toBe("read");
    expect(shellExploreKind("cat a.ts b.ts | head -50")).toBe("read");
    expect(shellExploreKind('grep -n "case \\"|default:" packages/server/src/app.ts | head')).toBe("search");
    expect(shellExploreKind("rg -l 'foo bar' src && echo done")).toBe("search");
    expect(shellExploreKind("ls -la ~/.vgent/harness")).toBe("list");
    expect(shellExploreKind("find . -name '*.ts' -not -path '*/node_modules/*'")).toBe("list");
    expect(shellExploreKind("git log --oneline -5 -- apps/web && git status --short")).toBe("read");
    expect(shellExploreKind("git branch -a")).toBe("list");
    expect(shellExploreKind("FOO=1 cat x.ts 2>/dev/null")).toBe("read");
  });

  it("calls everything that could change something, or that it cannot see through, a command", () => {
    expect(shellExploreKind("pnpm build && pnpm test")).toBeUndefined();
    expect(shellExploreKind("sed -i '' 's/a/b/' x.ts")).toBeUndefined();
    expect(shellExploreKind("cat x.ts > y.ts")).toBeUndefined();
    expect(shellExploreKind("d=~/x; c=$(ls $d); echo $c")).toBeUndefined();
    expect(shellExploreKind("python3 - <<'EOF'\nprint(1)\nEOF")).toBeUndefined();
    expect(shellExploreKind("for f in *.ts; do cat $f; done")).toBeUndefined();
    expect(shellExploreKind("find . -name '*.log' -delete")).toBeUndefined();
    expect(shellExploreKind("git branch -D old")).toBeUndefined();
    expect(shellExploreKind("git checkout main")).toBeUndefined();
    expect(shellExploreKind("echo hi")).toBeUndefined();
    expect(shellExploreKind("cd /tmp")).toBeUndefined();
    expect(shellExploreKind("")).toBeUndefined();
  });
});

describe("exploreLabel", () => {
  it("counts each kind of look on one line", () => {
    const tools = toolBlocks([
      tool("c1", "Read", { file_path: "a.ts" }),
      tool("c2", "Bash", { command: "sed -n 1,20p b.ts" }),
      tool("c3", "Grep", { pattern: "x" }),
      tool("c4", "Bash", { command: "ls src" }),
    ]);
    expect(exploreLabel(exploreCounts(tools))).toBe("读取 2 个文件 · 搜索 1 次 · 列出 1 个目录");
  });
});
