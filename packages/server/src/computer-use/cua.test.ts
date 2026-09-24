import { describe, expect, it } from "vitest";
import type { ToolExec } from "../exec.js";
import { getCuaStatus, onlyCuaTools } from "./cua.js";

describe("Cua Driver integration", () => {
  it("only exposes the reviewed desktop tools from the MCP server", () => {
    expect(onlyCuaTools({ cua__list_apps: 1, cua__click: 2, cua__kill_app: 3, cua__clipboard_read: 4 }))
      .toEqual({ cua__list_apps: 1, cua__click: 2 });
  });

  it("treats unknown permission status as not ready", async () => {
    const exec: ToolExec = async (_file, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "cua-driver 0.19.1\n", stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: "Cua Driver daemon is running\n  permission mode: standard (built_in_default)\n", stderr: "" };
      return { code: 0, stdout: '{"accessibility":true}', stderr: "" };
    };
    const status = await getCuaStatus(exec, [process.execPath]);
    expect(status).toMatchObject({ installed: true, running: true, permissionMode: "standard", accessibility: true, screenRecording: null, ready: false });
  });
});
