import { describe, expect, it } from "vitest";
import { createApiKeyModel } from "./api-key-model.js";

describe("createApiKeyModel", () => {
  it("returns a gateway language model for a provider/model spec", () => {
    const model = createApiKeyModel("openai/gpt-5.5");
    expect(model).toMatchObject({ modelId: "openai/gpt-5.5" });
  });

  it.each(["gpt-5.5", "/gpt-5.5", "openai/", "openai gpt-5.5"])("rejects %j", (spec) => {
    expect(() => createApiKeyModel(spec)).toThrow(/expected "provider\/model"/);
  });
});
