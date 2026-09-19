import { describe, expect, it } from "vitest";
import { formatBytes, isImage, partitionBySize, toFileParts } from "./attachments";

describe("attachments", () => {
  it("formats sizes the way a tile shows them", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(12 * 1024)).toBe("12 KB");
    expect(formatBytes(3.4 * 1024 * 1024)).toBe("3.4 MB");
  });

  it("keeps what fits and names what does not", () => {
    const files = [
      { name: "a.png", size: 10 },
      { name: "huge.mov", size: 99 },
    ];
    expect(partitionBySize(files, 50)).toEqual({ accepted: [files[0]], rejected: ["huge.mov"] });
  });

  it("turns attachments into file parts", () => {
    expect(toFileParts([{ id: "1", name: "a.png", mediaType: "image/png", url: "data:image/png;base64,AA", size: 1 }])).toEqual([
      { type: "file", mediaType: "image/png", filename: "a.png", url: "data:image/png;base64,AA" },
    ]);
    expect(isImage("image/webp")).toBe(true);
    expect(isImage("application/pdf")).toBe(false);
  });
});
