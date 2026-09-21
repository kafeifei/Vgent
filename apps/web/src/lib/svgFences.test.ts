import { describe, expect, it } from "vitest";
import { fenceBareSvg } from "./svgFences";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">\n  <title>t</title>\n\n  <rect/>\n</svg>';

describe("fenceBareSvg", () => {
  it("fences a drawing pasted straight into the reply", () => {
    expect(fenceBareSvg(SVG)).toBe(`\`\`\`svg\n${SVG}\n\`\`\`\n\n`);
    expect(fenceBareSvg(`画好了：\n${SVG}\n还要改吗？`)).toBe(`画好了：\n\n\n\`\`\`svg\n${SVG}\n\`\`\`\n\n\n还要改吗？`);
    expect(fenceBareSvg(`<?xml version="1.0"?>\n${SVG}`)).toBe(`\`\`\`svg\n<?xml version="1.0"?>\n${SVG}\n\`\`\`\n\n`);
  });

  it("opens a fence for a drawing that is still streaming", () => {
    expect(fenceBareSvg('好的：\n<svg viewBox="0 0 1 1">\n  <rect')).toBe('好的：\n\n\n```svg\n<svg viewBox="0 0 1 1">\n  <rect\n');
    // A finished one followed by one in flight.
    const both = fenceBareSvg(`${SVG}\n<svg><circle`);
    expect(both.startsWith(`\`\`\`svg\n${SVG}\n\`\`\`\n\n`)).toBe(true);
    expect(both.endsWith("```svg\n<svg><circle\n")).toBe(true);
  });

  it("leaves code and everything else alone", () => {
    const fenced = `\`\`\`svg\n${SVG}\n\`\`\``;
    expect(fenceBareSvg(fenced)).toBe(fenced);
    expect(fenceBareSvg("用 `<svg>` 标签")).toBe("用 `<svg>` 标签");
    expect(fenceBareSvg("没有图")).toBe("没有图");
    expect(fenceBareSvg("<svgfoo>不是</svgfoo>")).toBe("<svgfoo>不是</svgfoo>");
  });
});
