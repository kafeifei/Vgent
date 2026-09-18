import { describe, expect, it } from "vitest";
import { isImeKeyEvent } from "./ime";

describe("isImeKeyEvent", () => {
  it("is true while the input method is composing", () => {
    expect(isImeKeyEvent({ nativeEvent: { isComposing: true, keyCode: 13 } })).toBe(true);
  });

  it("is true for WebKit's Enter that confirms a candidate: not composing any more, keyCode 229", () => {
    expect(isImeKeyEvent({ nativeEvent: { isComposing: false, keyCode: 229 } })).toBe(true);
  });

  it("takes a bare DOM event too (the window-level Escape listeners)", () => {
    expect(isImeKeyEvent({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeKeyEvent({ isComposing: false, keyCode: 27 })).toBe(false);
  });

  it("is false for a plain Enter", () => {
    expect(isImeKeyEvent({ nativeEvent: { isComposing: false, keyCode: 13 } })).toBe(false);
  });
});
