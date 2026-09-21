import { describe, expect, it } from "vitest";
import { drawingFor, outputCandidates, writtenDrawings } from "./outputs";
import type { Block } from "./turns";

const text = (value: string): Block => ({ kind: "text", key: value, part: { type: "text", text: value } });
const write = (file: string, state = "output-available"): Block =>
  ({ kind: "tool", key: file, part: { type: "tool-Write", toolCallId: file, state, input: { file_path: file, content: "" }, output: "ok" } }) as unknown as Block;

describe("outputCandidates", () => {
  it("takes the pictures a turn wrote and whatever the reply names", () => {
    expect(
      outputCandidates([
        write("/repo/pelican-bicycle.svg"),
        write("/repo/src/app.ts"),
        write("/repo/docs/notes.md"),
        write("/repo/docs/guide.md"),
        write("/repo/half.png", "input-available"),
        text("画好了，存成 `pelican-bicycle.svg`。对比图见 [chart](out/a%20b.png)，已经贴出来的 ![x](shown.png) 不算，说明在 `docs/guide.md`，源码是 `src/app.ts`。"),
      ]),
    ).toEqual(["/repo/pelican-bicycle.svg", "out/a b.png", "pelican-bicycle.svg", "docs/guide.md"]);
  });

  it("leaves out a file the reply mentions but the turn never touched", () => {
    const bash = { kind: "tool", key: "b", part: { type: "tool-bash", toolCallId: "b", state: "output-available", input: { command: "git status --short" }, output: { stdout: "?? pelican-bicycle.svg" } } } as unknown as Block;
    expect(outputCandidates([bash, text("没有改代码；只发现一个未跟踪文件 `pelican-bicycle.svg`，没有动它。")])).toEqual([]);
    const made = { kind: "tool", key: "c", part: { type: "tool-bash", toolCallId: "c", state: "output-available", input: { command: "python3 draw.py > chart.svg" }, output: {} } } as unknown as Block;
    expect(outputCandidates([made, text("图在 `chart.svg`。")])).toEqual(["chart.svg"]);
  });

  it("ignores the web, code fences and words that only look like code", () => {
    expect(
      outputCandidates([
        text("![logo](https://x.dev/logo.png) 用 `npm run build` 生成\n```md\n`inside.svg`\n```\n另有 `two words.png`"),
      ]),
    ).toEqual([]);
  });
});

describe("writtenDrawings", () => {
  const call = (type: string, input: Record<string, unknown>, state = "output-available"): Block =>
    ({ kind: "tool", key: JSON.stringify(input), part: { type, toolCallId: "c", state, input, output: "ok" } }) as unknown as Block;

  it("replays a turn's write and the edits after it, so the turn keeps its own drawing", () => {
    const drawings = writtenDrawings([
      call("tool-write", { file_path: "pelican.svg", content: "<svg><a/><b/><b/></svg>" }),
      call("tool-edit", { file_path: "pelican.svg", old_string: "<a/>", new_string: "" }),
      call("tool-edit", { file_path: "pelican.svg", old_string: "<b/>", new_string: "<c/>", replace_all: true }),
      call("tool-write", { file_path: "notes.md", content: "# 说明" }),
      call("tool-write", { file_path: "half.svg", content: "<svg/>" }, "input-available"),
    ]);
    expect([...drawings]).toEqual([["pelican.svg", "<svg><c/><c/></svg>"]]);
  });

  it("carries what earlier turns left, and finds it under whichever spelling the server resolved", () => {
    const first = writtenDrawings([call("tool-write", { file_path: "/scratch/t1/pelican.svg", content: "<svg>1</svg>" })]);
    const second = writtenDrawings([], first);
    const third = writtenDrawings([call("tool-write", { file_path: "/scratch/t1/pelican.svg", content: "<svg>2</svg>" })], second);
    const asked = { raw: "sandbox-link/pelican.svg", path: "pelican.svg" };
    expect([first, second, third].map((held) => drawingFor(held, asked))).toEqual(["<svg>1</svg>", "<svg>1</svg>", "<svg>2</svg>"]);
    expect(first.get("/scratch/t1/pelican.svg")).toBe("<svg>1</svg>");
    expect(drawingFor(third, { raw: "other.svg", path: "other.svg" })).toBeUndefined();
  });

  it("lets go of a file it lost track of", () => {
    expect(
      writtenDrawings([
        call("tool-write", { file_path: "a.svg", content: "<svg/>" }),
        call("tool-edit", { file_path: "a.svg", old_string: "not there", new_string: "x" }),
      ]).size,
    ).toBe(0);
    // An edit with no write before it in this turn: the file on disk is all there is.
    expect(writtenDrawings([call("tool-edit", { file_path: "b.svg", old_string: "a", new_string: "b" })]).size).toBe(0);
  });
});
