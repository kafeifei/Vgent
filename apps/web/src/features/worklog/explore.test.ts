import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { exploreCounts, exploreItemsOf, exploreLabel, shellExploreKind } from "./explore";
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

describe("exploreItemsOf", () => {
  it("folds two or more consecutive looks and leaves a lone look and every command on its own line", () => {
    const items = exploreItemsOf(
      toolBlocks([
        tool("c1", "Read", { file_path: "a.ts" }),
        tool("c2", "Bash", { command: "sed -n 1,20p b.ts" }),
        tool("c3", "Grep", { pattern: "x" }),
        tool("c4", "Bash", { command: "pnpm test" }),
        tool("c5", "Bash", { command: "ls src" }),
        tool("c6", "Edit", { file_path: "a.ts" }),
        tool("c7", "Read", { file_path: "c.ts" }),
        tool("c8", "Read", { file_path: "d.ts" }),
      ]),
    );
    expect(items.map((item) => (item.kind === "explore" ? `explore:${item.tools.length}` : item.block.key.split(":")[1]))).toEqual([
      "explore:3",
      "3",
      "4",
      "5",
      "explore:2",
    ]);
    const first = items[0];
    if (first?.kind !== "explore") throw new Error("expected a fold");
    expect(exploreLabel(exploreCounts(first.tools))).toBe("2 次读取 · 1 次搜索");
  });
});
