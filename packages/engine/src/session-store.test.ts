import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { beforeEach, describe, expect, it } from "vitest";
import { appendSession, loadSession } from "./session-store.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vgent-session-"));
  file = join(dir, "nested", "session.jsonl");
});

const user = (text: string): ModelMessage => ({ role: "user", content: text });

describe("appendSession", () => {
  it("creates the file and its directory, one JSON line per message", async () => {
    await appendSession(file, [user("first"), user("second")]);
    const raw = await readFile(file, "utf8");
    const lines = raw.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).message).toEqual(user("first"));
    expect(typeof JSON.parse(lines[0]!).ts).toBe("number");
  });

  it("appends instead of replacing", async () => {
    await appendSession(file, [user("first")]);
    await appendSession(file, [user("second")]);
    expect(await loadSession(file)).toEqual([user("first"), user("second")]);
  });

  it("writes nothing for an empty batch", async () => {
    await appendSession(file, []);
    expect(await loadSession(file)).toEqual([]);
  });
});

describe("loadSession", () => {
  it("returns an empty session for a missing file", async () => {
    expect(await loadSession(join(dir, "absent.jsonl"))).toEqual([]);
  });

  it("round-trips assistant and tool messages", async () => {
    const messages: ModelMessage[] = [
      user("read a.txt"),
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: { file_path: "a.txt" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "read", output: { type: "json", value: { content: "hi" } } }] },
      { role: "assistant", content: "hi" },
    ];
    await appendSession(file, messages);
    expect(await loadSession(file)).toEqual(messages);
  });

  it("skips a truncated trailing line and warns, keeping everything before it", async () => {
    await appendSession(file, [user("first"), user("second")]);
    // The shape a crash mid-append leaves: a partial JSON object, no newline.
    await appendFile(file, '{"ts":123,"message":{"role":"user","cont', "utf8");

    const warnings: string[] = [];
    expect(await loadSession(file, { onWarn: (w) => warnings.push(w) })).toEqual([user("first"), user("second")]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("truncated");
  });

  it("skips a corrupt line in the middle and keeps the rest", async () => {
    await writeFile(
      join(dir, "flat.jsonl"),
      `${JSON.stringify({ ts: 1, message: user("a") })}\nnot json\n${JSON.stringify({ ts: 2, message: user("b") })}\n`,
      "utf8",
    );
    const warnings: string[] = [];
    const messages = await loadSession(join(dir, "flat.jsonl"), {
      onWarn: (w) => warnings.push(w),
    });
    expect(messages).toEqual([user("a"), user("b")]);
    expect(warnings[0]).toContain("unparseable line 2");
  });

  it("skips a well-formed line that carries no message", async () => {
    await appendSession(file, [user("a")]);
    await appendFile(file, `${JSON.stringify({ ts: 1 })}\n`, "utf8");
    const warnings: string[] = [];
    expect(await loadSession(file, { onWarn: (w) => warnings.push(w) })).toEqual([user("a")]);
    expect(warnings).toHaveLength(1);
  });
});
