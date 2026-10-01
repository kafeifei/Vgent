import { describe, expect, it } from "vitest";
import { findSlash, matchSlash, removeSlash, type SlashCommand } from "./slash";

const command = (id: string, label: string, aliases?: string[]): SlashCommand => ({
  id,
  label,
  section: "",
  ...(aliases != null ? { aliases } : {}),
  run: () => undefined,
});

describe("findSlash", () => {
  it("opens at the start of the text, after whitespace and after a bracket", () => {
    expect(findSlash("/", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(findSlash("先看看 /pl", 7)).toEqual({ start: 4, end: 7, query: "pl" });
    expect(findSlash("a\n/plan", 7)).toEqual({ start: 2, end: 7, query: "plan" });
    expect(findSlash("(/co", 4)).toEqual({ start: 1, end: 4, query: "co" });
  });

  it("stays shut inside a path, after a space, and away from the caret", () => {
    expect(findSlash("src/app", 7)).toBeNull();
    expect(findSlash("看 src/app/x.ts", 13)).toBeNull();
    expect(findSlash("/plan 然后", 8)).toBeNull();
    expect(findSlash("/plan", 0)).toBeNull();
  });
});

describe("matchSlash", () => {
  const rows = [command("agent", "Agent"), command("plan", "Plan"), command("compact", "压缩上下文", ["summarize"])];

  it("lists everything for an empty query", () => {
    expect(matchSlash(rows, "").map((row) => row.id)).toEqual(["agent", "plan", "compact"]);
  });

  it("puts prefix matches first and finds a row by alias or label", () => {
    expect(matchSlash(rows, "p").map((row) => row.id)).toEqual(["plan", "compact"]);
    expect(matchSlash(rows, "sum").map((row) => row.id)).toEqual(["compact"]);
    expect(matchSlash(rows, "压缩").map((row) => row.id)).toEqual(["compact"]);
    expect(matchSlash(rows, "zzz")).toEqual([]);
  });
});

describe("removeSlash", () => {
  it("cuts the token out and leaves the rest of the draft alone", () => {
    expect(removeSlash("先看看 /pl 再说", { start: 4, end: 7, query: "pl" })).toEqual({ text: "先看看  再说", caret: 4 });
    expect(removeSlash("/plan", { start: 0, end: 5, query: "plan" })).toEqual({ text: "", caret: 0 });
  });
});
