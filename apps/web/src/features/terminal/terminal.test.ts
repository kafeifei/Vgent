import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { collectTerminalEntries } from "./terminal";

type Part = UIMessage["parts"][number];
const part = (type: string, rest: Record<string, unknown>): Part => ({ type, toolCallId: "c1", ...rest }) as unknown as Part;
const msg = (parts: Part[]): UIMessage => ({ id: "m1", role: "assistant", parts });

describe("collectTerminalEntries", () => {
  it("reads a completed vgent tool-bash call", () => {
    const messages = [
      msg([
        part("tool-bash", {
          toolCallId: "c1",
          state: "output-available",
          input: { command: "pnpm test" },
          output: { stdout: "ok", exitCode: 0 },
        }),
      ]),
    ];
    expect(collectTerminalEntries(messages)).toEqual([
      { id: "c1", command: "pnpm test", output: "ok", state: "done", exitCode: 0 },
    ]);
  });

  it("reads a dynamic-tool shell call still running", () => {
    const messages = [
      msg([
        part("dynamic-tool", {
          toolCallId: "c2",
          toolName: "bash",
          state: "input-available",
          input: { command: "ls -la" },
        }),
      ]),
    ];
    expect(collectTerminalEntries(messages)).toEqual([
      { id: "c2", command: "ls -la", output: undefined, state: "running" },
    ]);
  });

  it("captures an errored command", () => {
    const messages = [
      msg([
        part("tool-Bash", { toolCallId: "c3", state: "output-error", input: { command: "false" }, errorText: "denied" }),
      ]),
    ];
    expect(collectTerminalEntries(messages)).toEqual([{ id: "c3", command: "false", output: "denied", state: "error" }]);
  });

  it("reports a non-zero exit code", () => {
    const messages = [
      msg([
        part("tool-bash", {
          toolCallId: "c4",
          state: "output-available",
          input: { command: "exit 1" },
          output: { stdout: "", exitCode: 1 },
        }),
      ]),
    ];
    expect(collectTerminalEntries(messages)[0]).toMatchObject({ state: "done", exitCode: 1 });
  });

  it("ignores non-shell tool parts and walks messages in order", () => {
    const messages = [
      msg([part("tool-read", { toolCallId: "c5", state: "output-available", input: { file_path: "a.ts" }, output: "x" })]),
      msg([
        part("tool-bash", {
          toolCallId: "c6",
          state: "output-available",
          input: { command: "echo hi" },
          output: { stdout: "hi", exitCode: 0 },
        }),
      ]),
    ];
    const entries = collectTerminalEntries(messages);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe("c6");
  });
});
