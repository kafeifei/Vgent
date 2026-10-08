import { describe, expect, it } from "vitest";
import { selectApplicationUpdate } from "./runtime-environment.js";
const release = (version: string, arch = "arm64", extra = {}) => ({
  draft: false, prerelease: true, tag_name: `runtime-${"a".repeat(40)}`,
  assets: [{ name: `Vgent-${version}-mac-${arch}.zip`, browser_download_url: `https://github.com/kafeifei/Vgent/releases/download/runtime-${"a".repeat(40)}/Vgent-${version}-mac-${arch}.zip` }],
  ...extra,
});
describe("application release selection", () => {
  it("selects the newest compatible published installer numerically", () => {
    const result = selectApplicationUpdate([release("0.2.9"), release("0.2.223"), release("0.2.999", "x64"), release("0.2.998", "arm64", { draft: true })], "0.2.221", "arm64");
    expect(result.version).toBe("0.2.223");
    expect(result.updateAvailable).toBe(true);
    expect(result.prerelease).toBe(true);
    expect(selectApplicationUpdate([release("0.2.223")], "0.2.224", "arm64").updateAvailable).toBe(false);
  });
  it("rejects asset URLs outside the repository or release", () => {
    expect(selectApplicationUpdate([release("0.2.223", "arm64", { assets: [{ name: "Vgent-0.2.223-mac-arm64.zip", browser_download_url: "https://example.com/installer.zip" }] })], "0.2.221", "arm64").downloadUrl).toBeNull();
  });
});
