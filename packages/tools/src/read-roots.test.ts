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

it("snapshots root configuration for both tool descriptions and file execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "vgent-tool-snapshot-"));
  try {
    const workDir = join(root, "task"), project = join(root, "project"), other = join(root, "other");
    await Promise.all([workDir, project, other].map((path) => mkdir(path)));
    const writeRoots = [project];
    const tools = createCodingTools({ workDir, writeRoots });
    writeRoots.push(other);
    expect(tools.write!.description).toContain(project);
    expect(tools.write!.description).not.toContain(other);
    await tools.write!.execute!({ file_path: join(project, "ok.txt"), content: "ok" }, execOptions);
    await expect(tools.write!.execute!({ file_path: join(other, "no.txt"), content: "no" }, execOptions)).rejects.toThrow(/outside the working directory/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
