import { describe, expect, it } from "vitest";
import { baseName, oneLine, relativeTime, titleFromText } from "./format";

const NOW = Date.parse("2026-09-17T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("relativeTime", () => {
  it("walks from 刚刚 to 天前", () => {
    expect(relativeTime(ago(10_000), NOW)).toBe("刚刚");
    expect(relativeTime(ago(12 * 60_000), NOW)).toBe("12 分钟前");
    expect(relativeTime(ago(3 * 3600_000), NOW)).toBe("3 小时前");
    expect(relativeTime(ago(30 * 3600_000), NOW)).toMatch(/^昨天 \d\d:\d\d$/);
    expect(relativeTime(ago(5 * 86_400_000), NOW)).toBe("5 天前");
  });

  it("returns nothing for an unparsable timestamp", () => {
    expect(relativeTime("not-a-date", NOW)).toBe("");
  });
});

describe("text helpers", () => {
  it("takes the trailing path segment", () => {
    expect(baseName("packages/server/src/app.ts")).toBe("app.ts");
    expect(baseName("app.ts")).toBe("app.ts");
    expect(baseName("dist/")).toBe("dist");
  });

  it("flattens and cuts", () => {
    expect(oneLine("  a\n  b  ")).toBe("a b");
    expect(oneLine("abcdef", 4)).toBe("abc…");
  });

  it("titles from the first line only, capped", () => {
    expect(titleFromText("  第一行  \n第二行")).toBe("第一行");
    expect(titleFromText("x".repeat(80))).toHaveLength(60);
  });
});
