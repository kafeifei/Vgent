import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../store/settings.js";
import type { PermissionMode, Settings } from "../types.js";
import { effectivePermission } from "./capabilities.js";
import { createEngineRegistry, engineDescriptors } from "./registry.js";

const registry = createEngineRegistry();
const MODES: readonly PermissionMode[] = ["allow-reads", "allow-edits", "allow-all"];
const settingsWith = (runMode: PermissionMode, allowlist: string[] = []): Settings => ({
  ...DEFAULT_SETTINGS,
  runMode,
  allowlist,
});

describe("引擎能力表", () => {
  it("names every engine the registry serves", () => {
    expect(engineDescriptors(registry).map((entry) => entry.id)).toEqual(["codex", "claude-code", "vgent", "opencode"]);
    expect(engineDescriptors(registry).map((entry) => entry.label)).toEqual(["Codex", "Claude Code", "Vgent", "OpenCode"]);
  });

  it("matches 产品文档's table", () => {
    expect(registry["claude-code"].descriptor.capabilities).toEqual({
      approvals: true,
      askUser: true,
      planMode: true,
      compact: true,
      extensions: false,
      steer: true,
      customProviders: true,
    });
    expect(registry.codex.descriptor.capabilities).toEqual({
      approvals: false,
      askUser: false,
      planMode: false,
      compact: false,
      extensions: false,
      steer: true,
      customProviders: true,
    });
    expect(Object.values(registry.vgent.descriptor.capabilities).every(Boolean)).toBe(true);
    expect(registry.opencode.descriptor.capabilities).toEqual({
      approvals: true,
      askUser: true,
      planMode: true,
      compact: false,
      extensions: true,
      steer: true,
      customProviders: true,
    });
  });
});

describe("effectivePermission", () => {
  it("pins an engine that cannot ask to 全自动, whatever the run mode says", () => {
    for (const mode of MODES) {
      expect(effectivePermission(registry.codex.descriptor.capabilities, settingsWith(mode)).permissionMode).toBe("allow-all");
    }
  });

  it("gives every engine that can ask the global run mode", () => {
    for (const engine of ["claude-code", "vgent", "opencode"] as const) {
      for (const mode of MODES) {
        expect(effectivePermission(registry[engine].descriptor.capabilities, settingsWith(mode)).permissionMode).toBe(mode);
      }
    }
  });

  it("hands the global allowlist through unchanged", () => {
    const { alwaysAllow } = effectivePermission(registry.vgent.descriptor.capabilities, settingsWith("allow-reads", ["bash"]));
    expect(alwaysAllow).toEqual(["bash"]);
  });
});
