import { describe, expect, it } from "vitest";
import { harnessBootstrapRecipe } from "./bootstrap.js";
import { openCodeAuthContent } from "./opencode.js";

describe("openCodeAuthContent", () => {
  it("is an empty login store without a login, so OpenCode never falls back to its own", () => {
    expect(JSON.parse(openCodeAuthContent())).toEqual({});
  });

  it("gives OpenCode a ChatGPT login it never refreshes itself", () => {
    expect(JSON.parse(openCodeAuthContent({ accessToken: "at", accountId: "acct" }))).toEqual({
      openai: { type: "oauth", access: "at", refresh: "host-managed", expires: Number.MAX_SAFE_INTEGER, accountId: "acct" },
    });
  });
});

describe("OpenCode bridge patch", () => {
  it("holds a permission request until its tool call is out (patches/@ai-sdk__harness-opencode)", async () => {
    const recipe = await harnessBootstrapRecipe("opencode");
    const bridge = recipe?.files.find((file) => file.path.endsWith("/bridge.mjs"))?.content ?? "";
    expect(bridge).toContain("heldPermissions");
    expect(bridge).toContain("toolCallIsOut(callID)");
  });
});
