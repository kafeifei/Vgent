import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const containerSizes = ["3xs", "2xs", "xs", "sm", "md", "lg", "xl", "2xl", "3xl"];
const tailwindRequire = createRequire(import.meta.resolve("@tailwindcss/vite"));
const { compile } = await import(tailwindRequire.resolve("@tailwindcss/node"));
let css: string;

beforeAll(async () => {
  const source = await readFile(new URL("./index.css", import.meta.url), "utf8");
  const compiled = await compile(source, {
    base: fileURLToPath(new URL(".", import.meta.url)),
    onDependency: () => {},
  });
  css = compiled.build([
    ...containerSizes.map((size) => `max-w-${size}`),
    "sm:max-w-md", "sm:max-w-lg", "w-md", "min-w-md", "max-w-figure", "max-w-64", "max-w-full",
  ]);
});

function declaration(className: string, property: string): string | undefined {
  const selector = `.${className.replaceAll(":", "\\:")} {`;
  const block = css.split(selector)[1]?.split("}")[0] ?? "";
  return [...block.matchAll(new RegExp(`${property}:\\s*([^;]+);`, "g"))].at(-1)?.[1];
}

describe("Tailwind width tokens", () => {
  it.each(containerSizes)("keeps max-w-%s at container width rather than spacing width", (size) => {
    expect(declaration(`max-w-${size}`, "max-width")).toBe(`var(--container-${size})`);
  });

  it("preserves container widths in responsive link and shared dialogs", () => {
    expect(declaration("sm:max-w-md", "max-width")).toBe("var(--container-md)");
    expect(declaration("sm:max-w-lg", "max-width")).toBe("var(--container-lg)");
  });

  it("leaves spacing widths, layout widths and numeric limits unchanged", () => {
    expect(declaration("w-md", "width")).toBe("var(--spacing-md)");
    expect(declaration("min-w-md", "min-width")).toBe("var(--spacing-md)");
    expect(declaration("max-w-figure", "max-width")).toBe("var(--spacing-figure)");
    expect(declaration("max-w-64", "max-width")).toBe("calc(var(--spacing) * 64)");
    expect(declaration("max-w-full", "max-width")).toBe("100%");
  });
});
