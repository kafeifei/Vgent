import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveDownload } from "./downloads.js";

describe("saveDownload", () => {
  it("never overwrites: a taken name gets a number", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "vgent-dl-")), "Downloads");
    const bytes = (text: string) => new TextEncoder().encode(text);
    expect(await saveDownload(dir, "鹈鹕 图.svg", bytes("a"))).toBe(join(dir, "鹈鹕 图.svg"));
    expect(await saveDownload(dir, "鹈鹕 图.svg", bytes("b"))).toBe(join(dir, "鹈鹕 图 (1).svg"));
    expect(await saveDownload(dir, "../../etc/x:y", bytes("c"))).toBe(join(dir, "x_y"));
    expect((await readdir(dir)).sort()).toEqual(["x_y", "鹈鹕 图 (1).svg", "鹈鹕 图.svg"]);
    expect(await readFile(join(dir, "鹈鹕 图.svg"), "utf8")).toBe("a");
  });
});
