import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCodingTools } from "./index.js";

const execOptions = { toolCallId: "t1", messages: [] } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("createCodingTools readRoots", () => {
  let root: string;
  let workDir: string;
  let skills: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "vgent-tools-roots-")));
    workDir = join(root, "repo");
    skills = join(root, "skills", "deploy");
    await mkdir(workDir, { recursive: true });
    await mkdir(skills, { recursive: true });
    await writeFile(join(skills, "SKILL.md"), "# deploy");
    await writeFile(join(root, "secret.txt"), "no");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lets read, and only read, reach an extra root", async () => {
    const tools = createCodingTools({ workDir, readRoots: [skills] });

    const read = (await tools.read!.execute!({ file_path: join(skills, "SKILL.md") }, execOptions)) as { content: string };
    expect(read.content).toContain("# deploy");

    await expect(tools.read!.execute!({ file_path: join(root, "secret.txt") }, execOptions)).rejects.toThrow(/outside the working directory/);
    await expect(tools.read!.execute!({ file_path: join(skills, "..", "..", "secret.txt") }, execOptions)).rejects.toThrow(/outside the working directory/);
    await expect(
      tools.write!.execute!({ file_path: join(skills, "SKILL.md"), content: "x" }, execOptions),
    ).rejects.toThrow(/outside the working directory/);
  });
});
