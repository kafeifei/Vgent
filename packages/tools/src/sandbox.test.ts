/**
 * Exercises `createCodingTools` against a real `Experimental_SandboxSession`
 * (`@ai-sdk/sandbox-just-bash`) instead of the host filesystem, covering
 * `read`/`write`/`edit`/`bash` — the four tools that actually go through the
 * sandbox. `grep`/`glob` always walk the host filesystem directly (see
 * `src/index.ts`'s module doc: `Experimental_SandboxSession` has no
 * directory-listing primitive), so there is nothing sandbox-specific to test
 * for them here.
 */
import { createJustBashSandbox } from "@ai-sdk/sandbox-just-bash";
import type { Experimental_SandboxSession } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCodingTools } from "./index.js";

const execOptions = { toolCallId: "t1", messages: [] } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
const workDir = "/work";

describe("createCodingTools against just-bash", () => {
  let sandbox: Experimental_SandboxSession;
  let stop: () => Promise<void>;

  beforeEach(async () => {
    const provider = createJustBashSandbox({ cwd: workDir });
    const session = await provider.createSession();
    sandbox = session.restricted();
    stop = () => session.stop();
  });

  afterEach(async () => {
    await stop();
  });

  it("writes then reads a file", async () => {
    const tools = createCodingTools({ sandbox, workDir });
    await tools.write!.execute!({ file_path: "a.txt", content: "one\ntwo\n" }, execOptions);
    const result = await tools.read!.execute!({ file_path: "a.txt" }, execOptions);
    expect(result.content).toBe("     1\tone\n     2\ttwo");
    expect(result.totalLines).toBe(2);
  });

  it("write creates parent directories inside the sandbox", async () => {
    const tools = createCodingTools({ sandbox, workDir });
    const result = await tools.write!.execute!({ file_path: "nested/deep/a.txt", content: "hi" }, execOptions);
    expect(result.created).toBe(true);
    const read = await tools.read!.execute!({ file_path: "nested/deep/a.txt" }, execOptions);
    expect(read.content).toBe("     1\thi");
  });

  it("edits a file in the sandbox", async () => {
    const tools = createCodingTools({ sandbox, workDir });
    await tools.write!.execute!({ file_path: "a.txt", content: "foo\n" }, execOptions);
    const result = await tools.edit!.execute!({ file_path: "a.txt", old_string: "foo", new_string: "bar" }, execOptions);
    expect(result.replacements).toBe(1);
    const read = await tools.read!.execute!({ file_path: "a.txt" }, execOptions);
    expect(read.content).toBe("     1\tbar");
  });

  it("runs bash commands through the sandbox", async () => {
    const tools = createCodingTools({ sandbox, workDir });
    const result = await tools.bash!.execute!({ command: "echo hi from sandbox" }, execOptions);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hi from sandbox");
  });

  it("reports a nonzero exit code from the sandbox without throwing", async () => {
    const tools = createCodingTools({ sandbox, workDir });
    const result = await tools.bash!.execute!({ command: "exit 3" }, execOptions);
    expect(result.exitCode).toBe(3);
  });

  it("rejects a path that escapes the sandbox working directory", async () => {
    const tools = createCodingTools({ sandbox, workDir });
    await expect(tools.read!.execute!({ file_path: "../outside.txt" }, execOptions)).rejects.toThrow(/outside the working directory/);
  });
});
