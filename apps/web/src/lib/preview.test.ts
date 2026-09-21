import { describe, expect, it } from "vitest";
import { isSvgFence, localPathOf, previewKindOf, svgDataUri, svgForImage, taskFileOf, taskFileUrl, toBase64 } from "./preview";

describe("previewKindOf", () => {
  it("names what a file is shown as", () => {
    expect(previewKindOf("out/pelican-bicycle.svg")).toBe("svg");
    expect(previewKindOf("shot.PNG")).toBe("image");
    expect(previewKindOf("docs/README.md")).toBe("markdown");
    expect(previewKindOf("src/app.ts")).toBeUndefined();
    expect(previewKindOf(".svg")).toBeUndefined();
    expect(previewKindOf("dir.png/readme")).toBeUndefined();
  });
});

describe("isSvgFence", () => {
  it("takes svg by its tag and xml/html by what is inside", () => {
    expect(isSvgFence("svg", "anything")).toBe(true);
    expect(isSvgFence("xml", '<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"></svg>')).toBe(true);
    expect(isSvgFence("html", "  <svg></svg>")).toBe(true);
    expect(isSvgFence("html", "<div><svg/></div>")).toBe(false);
    expect(isSvgFence("xml", "<svgfoo/>")).toBe(false);
    expect(isSvgFence("ts", "<svg/>")).toBe(false);
  });
});

describe("svgDataUri", () => {
  it("adds the namespace an image needs and drops a prolog", () => {
    const uri = svgDataUri('<?xml version="1.0"?><svg viewBox="0 0 1 1"><rect/></svg>');
    expect(decodeURIComponent(uri.split(",")[1] ?? "")).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect/></svg>');
    expect(svgDataUri('<svg xmlns="http://www.w3.org/2000/svg"/>')).toContain(encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    expect(svgDataUri("not a drawing")).toBe("");
  });
});

describe("svgForImage / toBase64", () => {
  it("leaves the markup alone apart from the namespace", () => {
    expect(svgForImage("<svg><script>x</script></svg>")).toBe('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>');
    expect(svgForImage("nope")).toBeUndefined();
  });

  it("encodes more bytes than one call stack can spread", () => {
    const bytes = new Uint8Array(100_000).fill(65);
    expect(atob(toBase64(bytes))).toBe("A".repeat(100_000));
    expect(atob(toBase64(new TextEncoder().encode("鹈")))).toBe("\u00e9\u00b9\u0088");
  });
});

describe("taskFileUrl", () => {
  it("carries any path through a URL and back", () => {
    for (const path of ["a.png", "out/对比 图.png", "/Users/me/a b#1?.svg", "../x/100%.png"]) {
      expect(taskFileUrl(path).startsWith("/__task_file__/")).toBe(true);
      expect(taskFileOf(taskFileUrl(path))).toBe(path);
    }
    expect(taskFileOf("/other/a.png")).toBeUndefined();
    expect(taskFileOf("/__task_file__/%E0%A4%A")).toBeUndefined();
  });
});

describe("localPathOf", () => {
  it("keeps the task's own files and leaves the web alone", () => {
    expect(localPathOf("pelican.svg")).toBe("pelican.svg");
    expect(localPathOf("./out/a.png?raw=1#x")).toBe("./out/a.png");
    expect(localPathOf("/Users/me/repo/a.png")).toBe("/Users/me/repo/a.png");
    expect(localPathOf("file:///Users/me/a%20b.png")).toBe("/Users/me/a b.png");
    expect(localPathOf("out/%E9%B9%88%E9%B9%95.svg")).toBe("out/鹈鹕.svg");
    expect(localPathOf("out/100%.png")).toBe("out/100%.png");
    for (const web of ["https://x.dev/a.png", "data:image/png;base64,AA", "blob:http://x/1", "//cdn/a.png", "#anchor", "mailto:a@b", ""]) {
      expect(localPathOf(web)).toBeUndefined();
    }
  });
});
