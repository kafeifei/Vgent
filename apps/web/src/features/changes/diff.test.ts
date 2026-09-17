import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./diff";

const TWO_HUNKS = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,4 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  " const c = 4;",
  "@@ -10,3 +10,4 @@ export function f() {",
  "   return a;",
  "+  // tail",
  " }",
  "",
].join("\n");

const NEW_FILE = [
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,3 @@",
  "+one",
  "+two",
  "+three",
  "",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("numbers adds, dels and context across two hunks", () => {
    const lines = parseUnifiedDiff(TWO_HUNKS);

    expect(lines.map((line) => line.kind)).toEqual([
      "hunk",
      "ctx",
      "del",
      "add",
      "ctx",
      "hunk",
      "ctx",
      "add",
      "ctx",
    ]);
    expect(lines.map((line) => [line.oldNo, line.newNo])).toEqual([
      [undefined, undefined],
      [1, 1],
      [2, undefined],
      [undefined, 2],
      [3, 3],
      [undefined, undefined],
      [10, 10],
      [undefined, 11],
      [11, 12],
    ]);
    // The `---` / `+++` header lines never become del / add lines.
    expect(lines.some((line) => line.text.startsWith("---"))).toBe(false);
    expect(lines.some((line) => line.text.startsWith("+++"))).toBe(false);
  });

  it("numbers a new file from 1", () => {
    const lines = parseUnifiedDiff(NEW_FILE);

    expect(lines[0]).toEqual({ kind: "hunk", text: "@@ -0,0 +1,3 @@" });
    expect(lines.slice(1)).toEqual([
      { kind: "add", text: "+one", newNo: 1 },
      { kind: "add", text: "+two", newNo: 2 },
      { kind: "add", text: "+three", newNo: 3 },
    ]);
  });

  it("keeps the no-newline marker as a note", () => {
    const lines = parseUnifiedDiff("@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n");

    expect(lines.at(-1)).toEqual({ kind: "note", text: "\\ No newline at end of file" });
  });

  it("returns nothing for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});
