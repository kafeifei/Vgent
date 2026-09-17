import { describe, expect, it } from "vitest";
import { SANDBOX_LOCAL_PACKAGE_NAME } from "./index.js";

describe("@vgent/sandbox-local", () => {
  it("exports a placeholder", () => {
    expect(SANDBOX_LOCAL_PACKAGE_NAME).toBe("@vgent/sandbox-local");
  });
});
