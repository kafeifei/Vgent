import { describe, expect, it } from "vitest";
import { copySize } from "./copyPicture";

describe("copySize", () => {
  it("keeps a bitmap's own pixels and scales a drawing up to be worth pasting", () => {
    expect(copySize({ width: 640, height: 480 }, false)).toEqual({ width: 640, height: 480 });
    expect(copySize({ width: 960, height: 800 }, true)).toEqual({ width: 2048, height: 1707 });
    expect(copySize({ width: 0, height: 0 }, true)).toEqual({ width: 2048, height: 2048 });
    expect(copySize({ width: 0, height: 0 }, false)).toEqual({ width: 1024, height: 1024 });
  });
});
