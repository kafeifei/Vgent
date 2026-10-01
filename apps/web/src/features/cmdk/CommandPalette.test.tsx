import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette, type Command } from "./CommandPalette";

const commands: Command[] = [
  { id: "new", label: "新建任务", hint: "⌘N", run: vi.fn() },
  { id: "settings", label: "打开设置", run: vi.fn() },
];

describe("CommandPalette", () => {
  const html = renderToStaticMarkup(<CommandPalette commands={commands} onClose={() => {}} />);

  it("is a modal dialog with a name", () => {
    expect(html).toMatch(/role="dialog"[^>]*aria-modal="true"|aria-modal="true"[^>]*role="dialog"/);
    expect(html).toContain('aria-label="命令面板"');
  });

  it("is a combobox over a listbox, and the first command is the one it points at", () => {
    const input = /<input[^>]*>/.exec(html)?.[0] ?? "";
    const listId = /aria-controls="([^"]+)"/.exec(input)?.[1];
    expect(input).toContain('role="combobox"');
    expect(listId).toBeDefined();
    expect(html).toContain(`id="${listId}" role="listbox"`);
    const active = /aria-activedescendant="([^"]+)"/.exec(input)?.[1];
    expect(active).toBe(`${listId}-0`);
    expect(html).toContain(`id="${active}"`);
  });

  it("marks exactly one option selected, and keeps the options out of the tab order", () => {
    expect(html.match(/role="option"/g)).toHaveLength(2);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(2);
  });
});
