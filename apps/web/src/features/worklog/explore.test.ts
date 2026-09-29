import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { exploreCounts, exploreKindOf, exploreLabel, shellExploreKind } from "./explore";
import { buildTurns, type Block } from "./turns";

const tool = (id: string, name: string, input: Record<string, unknown>, state = "output-available") =>
  ({ type: `tool-${name}`, toolCallId: id, state, input }) as unknown as UIMessage["parts"][number];

const toolBlocks = (parts: UIMessage["parts"]) =>
  (buildTurns([
    { id: "u", role: "user", parts: [{ type: "text", text: "问" }] },
    { id: "a", role: "assistant", parts },
  ])[0]?.blocks ?? []).filter((block): block is Extract<Block, { kind: "tool" }> => block.kind === "tool");

describe("shellExploreKind", () => {
  it("recognises Codex shell wrappers and repository/application inspection", () => {
    expect(shellExploreKind("/bin/zsh -lc 'cat package.json && rg --files apps | head -80'")).toBe("search");
    expect(shellExploreKind(String.raw`/bin/zsh -lc "rg -n \"debug|安装\" apps -g '!*.lock' | head -180"`)).toBe("search");
    expect(shellExploreKind("/bin/zsh -lc 'git status --short && git worktree list --porcelain && git branch --show-current'")).toBe("read");
    expect(shellExploreKind("/bin/zsh -lc 'git merge-base main task && git diff --stat main...task'")).toBe("read");
    expect(shellExploreKind("/bin/bash -l -c 'git -C /repo --no-pager log -1'")).toBe("read");
    expect(shellExploreKind("sh -c 'ls src'")).toBe("list");
    expect(shellExploreKind("/bin/zsh -lc \"pgrep -fl 'Vgent.app|vgent-desktop' || true; mdls -name kMDItemVersion /Applications/Vgent.app 2>/dev/null; defaults read /Applications/Vgent.app/Contents/Info CFBundleShortVersionString; ls -ld /Applications/Vgent.app\"")).toBe("read");
    expect(shellExploreKind("bash -c \"sh -c 'cat README.md'\"")).toBe("read");
  });

  it.each([
    "/bin/zsh -lc 'cat a.ts && pnpm build'",
    "/bin/zsh -lc 'git worktree add /tmp/new'",
    "/bin/zsh -lc 'git -C /repo checkout main'",
    "/bin/zsh -lc 'defaults write app setting value'",
    "/bin/zsh -lc 'cat a.ts > b.ts'",
    "/bin/zsh -lc 'sed -i x a.ts'",
    "/bin/zsh script.sh",
    "/bin/zsh -lc 'cat a.ts' name extra",
    "/bin/zsh -ic 'cat a.ts'",
    "/bin/zsh -lc 'unknown-command'",
    '/bin/zsh -lc "cat $(touch changed)"',
    '/bin/zsh -lc \'cat "$(touch changed)"\'',
    '/bin/zsh -lc "cat `touch changed`"',
  ])("keeps mutations and ambiguous shell programs out of exploration: %s", (command) => {
    expect(shellExploreKind(command)).toBeUndefined();
  });

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
  it("uses native command actions and counts a compound call once", () => {
    const tools = toolBlocks([
      tool("read", "Bash", { command: "custom-reader a.ts", commandActions: [{ type: "read", path: "a.ts" }] }),
      tool("search", "Bash", { command: "opaque-script", commandActions: [{ type: "read" }, { type: "search", query: "x" }] }),
      tool("list", "Bash", { command: "opaque-list", commandActions: [{ type: "listFiles", path: "/repo" }] }),
    ]);
    expect(exploreCounts(tools)).toEqual({ read: 1, search: 1, list: 1 });
  });

  it.each([[], [{ type: "unknown" }], [{ type: "read" }, { type: "unknown" }], [null], "invalid"].map(commandActions => ({ commandActions })))("respects unknown or invalid native actions: $commandActions", ({ commandActions }) => {
    const tools = toolBlocks([tool("native", "Bash", { command: "cat a.ts", commandActions })]);
    expect(exploreKindOf(tools[0]!.part)).toBeUndefined();
  });

  it("counts each kind of look on one line", () => {
    const tools = toolBlocks([
      tool("c1", "Read", { file_path: "a.ts" }),
      tool("c2", "Bash", { command: "sed -n 1,20p b.ts" }),
      tool("c3", "Grep", { pattern: "x" }),
      tool("c4", "Bash", { command: "ls src" }),
    ]);
    expect(exploreLabel(exploreCounts(tools))).toBe("读取 2 次 · 搜索 1 次 · 列目录 1 次");
  });
});
