import { describe, expect, it } from "vitest";
import { taskFileOf } from "./preview";
import { rehypeTaskFiles } from "./rehypeTaskFiles";

const element = (tagName: string, properties: Record<string, unknown>, children: unknown[] = []) => ({ type: "element", tagName, properties, children });

describe("rehypeTaskFiles", () => {
  it("rewrites local images and links and leaves the web alone", () => {
    const local = element("img", { src: "out/a%20b.png" });
    const file = element("a", { href: "file:///Users/me/guide.md" });
    const web = element("img", { src: "https://x.dev/a.png" });
    const anchor = element("a", { href: "#top" });
    rehypeTaskFiles()({ type: "root", children: [element("p", {}, [local, file, web, anchor])] } as never);
    expect(taskFileOf(local.properties.src as string)).toBe("out/a b.png");
    expect(file).toMatchObject({ tagName: "task-file", properties: { path: "/Users/me/guide.md" } });
    expect(web.properties.src).toBe("https://x.dev/a.png");
    expect(anchor.properties.href).toBe("#top");
  });
});
