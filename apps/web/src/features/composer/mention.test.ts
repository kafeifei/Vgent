import { describe, expect, it } from "vitest";
import { acceptMention, findMention, mentionSegments } from "./mention";

describe("findMention", () => {
  it("opens on an @ at the start or after whitespace", () => {
    expect(findMention("@", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(findMention("看看 @src/ap", 10)).toEqual({ start: 3, end: 10, query: "src/ap" });
    expect(findMention("行\n@a", 4)).toEqual({ start: 2, end: 4, query: "a" });
    // Only the text before the caret counts.
    expect(findMention("@src/app.ts", 4)).toEqual({ start: 0, end: 4, query: "src" });
  });

  it("stays shut for anything that is not a fresh mention", () => {
    expect(findMention("", 0)).toBeNull();
    expect(findMention("mail@example.com", 16)).toBeNull();
    expect(findMention("@a@b", 4)).toBeNull();
    // The caret left the token.
    expect(findMention("@src 后面", 7)).toBeNull();
  });
});

describe("acceptMention", () => {
  const at = (text: string, caret: number) => {
    const mention = findMention(text, caret);
    if (mention == null) throw new Error("没有可接受的 mention");
    return mention;
  };

  it("replaces the query with the full path and a space", () => {
    expect(acceptMention("看看 @ap", at("看看 @ap", 6), { path: "src/app.ts", kind: "file" })).toEqual({
      text: "看看 @src/app.ts ",
      caret: 15,
    });
  });

  it("gives a directory a trailing slash", () => {
    expect(acceptMention("@sr", at("@sr", 3), { path: "src/deep", kind: "dir" })).toEqual({
      text: "@src/deep/ ",
      caret: 11,
    });
  });

  it("keeps the tail and does not double the separating space", () => {
    expect(acceptMention("@ap 尾巴", at("@ap 尾巴", 3), { path: "a.ts", kind: "file" })).toEqual({
      text: "@a.ts 尾巴",
      caret: 5,
    });
  });
});

describe("mentionSegments", () => {
  it("marks the @path runs and leaves the rest alone", () => {
    expect(mentionSegments("看 @a.ts 和 @b/c.ts 吧")).toEqual([
      { text: "看 ", mention: false },
      { text: "@a.ts", mention: true },
      { text: " 和 ", mention: false },
      { text: "@b/c.ts", mention: true },
      { text: " 吧", mention: false },
    ]);
    expect(mentionSegments("")).toEqual([]);
    expect(mentionSegments("没有引用")).toEqual([{ text: "没有引用", mention: false }]);
  });
});
