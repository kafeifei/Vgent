import { describe, expect, it } from "vitest";
import { shortcutKey } from "./Popover";

const press = (key: string, extra: Partial<Parameters<typeof shortcutKey>[0]> = {}) =>
  shortcutKey({ key, metaKey: false, ctrlKey: false, altKey: false, repeat: false, isComposing: false, keyCode: 0, ...extra });

describe("shortcutKey", () => {
  it("matches a letter whatever its case, and Enter", () => {
    expect(press("a")).toBe("a");
    expect(press("A")).toBe("a");
    expect(press("Enter")).toBe("enter");
  });

  it("leaves chords to the app: ⌘N is a new task, not a menu row", () => {
    expect(press("n", { metaKey: true })).toBeNull();
    expect(press("d", { ctrlKey: true })).toBeNull();
    expect(press("a", { altKey: true })).toBeNull();
  });

  it("does not fire twice for a held key", () => {
    expect(press("d", { repeat: true })).toBeNull();
  });

  it("ignores an input method's keys, including WebKit's late Enter", () => {
    expect(press("d", { isComposing: true })).toBeNull();
    expect(press("Enter", { keyCode: 229 })).toBeNull();
  });
});
