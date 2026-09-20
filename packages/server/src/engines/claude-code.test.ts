import { describe, expect, it } from "vitest";
import { withLongContext } from "./claude-code.js";

describe("withLongContext", () => {
  it("asks for the long window on the model name, the way /model spells it", () => {
    expect(withLongContext("opus", 1_000_000)).toBe("opus[1m]");
    expect(withLongContext("anthropic-claude/claude-opus-5", 1_050_000)).toBe("anthropic-claude/claude-opus-5[1m]");
  });

  it("leaves the name alone for the standard window, for no choice, and when it already says so", () => {
    expect(withLongContext("opus", 200_000)).toBe("opus");
    expect(withLongContext("opus", undefined)).toBe("opus");
    expect(withLongContext("opus[1m]", 1_000_000)).toBe("opus[1m]");
  });
});
