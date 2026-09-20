import { describe, expect, it } from "vitest";
import { normalizeMathDelimiters } from "./mathDelimiters";

describe("normalizeMathDelimiters", () => {
  it("turns LaTeX's own delimiters into dollars", () => {
    expect(normalizeMathDelimiters("质能方程 \\(E = mc^2\\) 很短")).toBe("质能方程 $$E = mc^2$$ 很短");
    expect(normalizeMathDelimiters("所以：\\[\n\\int_0^1 x\\,dx = \\frac12\n\\]完")).toBe("所以：\n$$\n\\int_0^1 x\\,dx = \\frac12\n$$\n完");
  });

  it("leaves code and everything else alone", () => {
    const fenced = "```js\nconst re = /\\(a\\)/;\n```";
    expect(normalizeMathDelimiters(fenced)).toBe(fenced);
    expect(normalizeMathDelimiters("正则 `\\(x\\)` 和 \\(y\\)")).toBe("正则 `\\(x\\)` 和 $$y$$");
    expect(normalizeMathDelimiters("花了 $5 和 $10")).toBe("花了 $5 和 $10");
    // A fence still streaming protects its tail.
    expect(normalizeMathDelimiters("```tex\n\\(a\\)")).toBe("```tex\n\\(a\\)");
    // An opener with no closer is not math yet.
    expect(normalizeMathDelimiters("写到一半 \\(a + b")).toBe("写到一半 \\(a + b");
  });
});
