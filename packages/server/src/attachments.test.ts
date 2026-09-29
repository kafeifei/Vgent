import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UIMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { decodeDataUrl, isTextAttachment, prepareAttachments, safeFileName } from "./attachments.js";

const dataUrl = (mediaType: string, text: string): string => `data:${mediaType};base64,${Buffer.from(text).toString("base64")}`;

const userMessage = (parts: UIMessage["parts"]): UIMessage => ({ id: "m1", role: "user", parts });

const dirs: string[] = [];
const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "vgent-att-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("helpers", () => {
  it("decodes base64 and plain data URLs, and nothing else", () => {
    expect(new TextDecoder().decode(decodeDataUrl(dataUrl("text/plain", "你好")))).toBe("你好");
    expect(new TextDecoder().decode(decodeDataUrl("data:text/plain,a%20b"))).toBe("a b");
    expect(decodeDataUrl("https://example.com/a.png")).toBeUndefined();
  });

  it("keeps a file name to one harmless path segment", () => {
    expect(safeFileName("../../etc/passwd", "x")).toBe("_.._etc_passwd");
    expect(safeFileName("", "fallback")).toBe("fallback");
    expect(safeFileName("截图 1.png", "x")).toBe("截图 1.png");
  });

  it.each([
    ["a".repeat(200) + ".txt", "a".repeat(116) + ".txt"],
    ["中".repeat(80) + ".txt", "中".repeat(38) + ".txt"],
    ["😀".repeat(80) + "a.txt", "😀".repeat(28) + "a.txt"],
    ["中a😀".repeat(80) + ".txt", "😀" + "中a😀".repeat(14) + ".txt"],
  ])("keeps a UTF-8 suffix without splitting code points: %s", (name, expected) => {
    const result = safeFileName(name, "fallback");
    expect(result).toBe(expected);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(120);
    expect(result.endsWith(".txt")).toBe(true);
    expect(Buffer.from(result, "utf8").toString("utf8")).toBe(result);
    expect(result).not.toContain("\uFFFD");
  });

  it("preserves the fallback when cleaning leaves an empty name", () => {
    const fallback = "中".repeat(80);
    expect(safeFileName(undefined, fallback)).toBe(fallback);
    expect(safeFileName("...\u0000 ", fallback)).toBe(fallback);
  });

  it("tells text from binary by media type or extension", () => {
    expect(isTextAttachment({ mediaType: "text/markdown", filename: "a.md" })).toBe(true);
    expect(isTextAttachment({ mediaType: "application/octet-stream", filename: "main.rs" })).toBe(true);
    expect(isTextAttachment({ mediaType: "application/zip", filename: "a.zip" })).toBe(false);
  });
});

describe("prepareAttachments", () => {
  it("returns the very same array when nothing is attached", async () => {
    const messages = [userMessage([{ type: "text", text: "hi" }])];
    expect(await prepareAttachments(messages, { engine: "codex", dir: "/nonexistent" })).toBe(messages);
  });

  it("writes the file out and names its path for a harness engine", async () => {
    const dir = await scratch();
    const messages = [
      userMessage([
        { type: "text", text: "看这张图" },
        { type: "file", mediaType: "image/png", filename: "shot.png", url: dataUrl("image/png", "PNGDATA") },
      ]),
    ];
    const [prepared] = await prepareAttachments(messages, { engine: "claude-code", dir });
    expect(prepared?.parts.every((part) => part.type === "text")).toBe(true);
    expect(await readdir(dir)).toEqual(["m1-1-shot.png"]);
    expect(await readFile(join(dir, "m1-1-shot.png"), "utf8")).toBe("PNGDATA");
    const note = prepared?.parts[1];
    expect(note?.type === "text" && note.text).toContain(join(dir, "m1-1-shot.png"));
    // The stored message is untouched: the log still draws the image.
    expect(messages[0]?.parts[1]?.type).toBe("file");
  });

  it.each(["550e8400-e29b-41d4-a716-446655440000", "消息😀".repeat(80)])(
    "writes and reuses long Chinese filenames for message %s",
    async (id) => {
      const dir = await scratch();
      const content = "附件原始内容 😀\n第二行";
      const messages = [
        {
          ...userMessage([
            { type: "text", text: "请看附件" },
            { type: "file", mediaType: "text/plain", filename: "中".repeat(80) + ".txt", url: dataUrl("text/plain", content) },
          ]),
          id,
        },
      ];
      const original = structuredClone(messages);
      const options = { engine: "codex" as const, dir };
      const prepared = await prepareAttachments(messages, options);
      const files = await readdir(dir);
      expect(files).toEqual([`${safeFileName(id, "message")}-1-${"中".repeat(38)}.txt`]);
      const filename = files[0]!;
      expect(Buffer.byteLength(filename, "utf8")).toBeLessThanOrEqual(255);
      expect(await readFile(join(dir, filename))).toEqual(Buffer.from(content, "utf8"));
      const note = prepared[0]?.parts[1];
      expect(note?.type === "text" && note.text).toContain(join(dir, filename));
      expect(messages).toEqual(original);

      expect(await prepareAttachments(messages, options)).toEqual(prepared);
      expect(await readdir(dir)).toEqual(files);
      expect(await readFile(join(dir, filename))).toEqual(Buffer.from(content, "utf8"));
      expect(messages).toEqual(original);
    },
  );

  it("keeps images as file parts and inlines text for the in-house engine", async () => {
    const dir = await scratch();
    const image = { type: "file" as const, mediaType: "image/png", filename: "shot.png", url: dataUrl("image/png", "PNGDATA") };
    const [prepared] = await prepareAttachments(
      [
        userMessage([
          image,
          { type: "file", mediaType: "text/plain", filename: "notes.txt", url: dataUrl("text/plain", "第一行") },
          { type: "file", mediaType: "application/zip", filename: "a.zip", url: dataUrl("application/zip", "zz") },
        ]),
      ],
      { engine: "vgent", dir },
    );
    expect(prepared?.parts[0]).toEqual(image);
    const inlined = prepared?.parts[1];
    expect(inlined?.type === "text" && inlined.text).toContain("第一行");
    const refused = prepared?.parts[2];
    expect(refused?.type === "text" && refused.text).toContain("读不了");
    expect(await readdir(dir)).toEqual([]);
  });
});
