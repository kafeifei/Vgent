import { mkdtemp, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createCodingTools } from "./index.js";
import { createLocalRunner } from "./local-runner.js";
const dirs: string[] = [];
const temp = async () => {
  const dir = await mkdtemp(join(tmpdir(), "vgent-mutation-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const options = { toolCallId: "test", messages: [] };
const run = (tools: ReturnType<typeof createCodingTools>, name: string, input: unknown, signal?: AbortSignal) =>
  tools[name]!.execute!(input, { ...options, ...(signal ? { abortSignal: signal } : {}) }) as Promise<any>;
it("serializes read/modify/write across parent and child tool sets and canonical aliases", async () => {
  const dir = await temp();
  await writeFile(join(dir, "a"), "left=0\nright=0\n");
  await symlink(join(dir, "a"), join(dir, "alias"));
  const parent = createCodingTools({ workDir: dir });
  const child = createCodingTools({ workDir: dir });
  await Promise.all([
    run(parent, "edit", { file_path: "a", old_string: "left=0", new_string: "left=1" }),
    run(child, "edit", { file_path: "alias", old_string: "right=0", new_string: "right=1" }),
  ]);
  expect(await readFile(join(dir, "a"), "utf8")).toBe("left=1\nright=1\n");
});
it("rejects an overwrite based on a stale read, then accepts a fresh read", async () => {
  const dir = await temp();
  await writeFile(join(dir, "a"), "old");
  const parent = createCodingTools({ workDir: dir });
  const child = createCodingTools({ workDir: dir });
  await run(parent, "read", { file_path: "a" });
  await run(child, "edit", { file_path: "a", old_string: "old", new_string: "child" });
  await expect(run(parent, "write", { file_path: "a", content: "overwrite" })).rejects.toThrow(/changed/);
  expect(await readFile(join(dir, "a"), "utf8")).toBe("child");
  await run(parent, "read", { file_path: "a" });
  await run(parent, "write", { file_path: "a", content: "updated" });
  expect(await readFile(join(dir, "a"), "utf8")).toBe("updated");
});
it("does not create directories or mutate files after pre-cancellation", async () => {
  const dir = await temp();
  const tools = createCodingTools({ workDir: dir });
  await writeFile(join(dir, "a"), "old");
  const signal = AbortSignal.abort();
  await expect(run(tools, "edit", { file_path: "a", old_string: "old", new_string: "bad" }, signal)).rejects.toThrow();
  await expect(run(tools, "write", { file_path: "nested/a", content: "bad" }, signal)).rejects.toThrow();
  expect(await readFile(join(dir, "a"), "utf8")).toBe("old");
  await expect(readFile(join(dir, "nested/a"))).rejects.toThrow();
});
it("keeps full shell output on disk with bounded in-memory previews", async () => {
  const dir = await temp();
  const outputs = join(dir, "outputs");
  const progress: number[] = [];
  const result = await createLocalRunner(dir, { outputDir: outputs, maxOutputChars: 200 }).run({
    command: "node -e \"process.stdout.write('a'.repeat(200000)); process.stderr.write('end')\"",
    onOutput: (value) => progress.push(value.stdout.length),
  });
  expect(result.outputTruncated).toBe(true);
  expect(result.stdout.length).toBeLessThan(500);
  expect((await readFile(result.outputFiles!.stdout, "utf8")).length).toBe(200000);
  expect(await readFile(result.outputFiles!.stderr, "utf8")).toBe("end");
  expect(progress.length).toBeGreaterThan(0);
});
it("canonicalizes an allowed read root without granting write access", async () => {
  const dir = await temp();
  const external = await temp();
  await writeFile(join(external, "SKILL.md"), "rule");
  const tools = createCodingTools({ workDir: dir, readRoots: [external] });
  expect((await run(tools, "read", { file_path: join(external, "SKILL.md") })).content).toContain("rule");
  await expect(run(tools, "write", { file_path: join(external, "SKILL.md"), content: "bad" })).rejects.toThrow(/outside/);
});

it("pages a large saved log through a canonical output-root alias", async () => {
  const dir = await temp();
  const outputs = await temp();
  const alias = join(dir, "logs");
  await symlink(outputs, alias);
  await writeFile(join(outputs, "large.log"), "skip\n".repeat(220000) + "TAIL\n");
  const tools = createCodingTools({ workDir: dir, outputDir: alias });
  const result = await run(tools, "read", { file_path: join(alias, "large.log"), offset: 220001, limit: 1 });
  expect(result.content).toContain("TAIL");
  expect(result).toMatchObject({ truncated: false, endsWithNewline: true, byteLength: 1100005 });
});
