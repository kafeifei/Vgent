import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MODES, modeRows } from "./modes";
import { SlashMenu } from "./SlashMenu";
import { matchSlash, type SlashCommand } from "./slash";

const run = () => undefined;
const noop = () => undefined;

const html = (rows: SlashCommand[], active = 0) => renderToStaticMarkup(<SlashMenu rows={rows} active={active} onRun={noop} onHover={noop} />);

describe("the / menu", () => {
  const rows: SlashCommand[] = [
    { id: "agent", label: "Agent", section: "模式", selected: true, run },
    { id: "plan", label: "Plan", section: "模式", run },
    { id: "compact", label: "压缩上下文", section: "操作", run },
    { id: "new", label: "新任务", section: "操作", run },
  ];

  it("lists each row's name and how to type it, under one small heading per group", () => {
    const markup = html(rows);
    for (const label of ["Agent", "Plan", "压缩上下文", "新任务"]) expect(markup).toContain(`>${label}</span>`);
    for (const typed of ["/agent", "/plan", "/compact", "/new"]) expect(markup).toContain(typed);
    expect(markup.match(/>模式<\/div>/g)).toHaveLength(1);
    expect(markup.match(/>操作<\/div>/g)).toHaveLength(1);
  });

  it("ticks the row that is in force, and only that one", () => {
    expect(html(rows).match(/lucide-check/g)).toHaveLength(1);
    expect(html(rows.map((row) => ({ ...row, selected: false }))).match(/lucide-check/g)).toBeNull();
  });

  it("carries no sentence: nothing about what a row does, nothing about why one is missing", () => {
    const markup = html(rows);
    // The words the menu used to add under each row.
    for (const chatter of ["直接动手", "先只读调研", "把这段对话压成摘要", "回到空白页", "不支持 Plan 模式", "运行中不能切换", "运行中不能压缩"]) {
      expect(markup).not.toContain(chatter);
    }
    // No row is drawn dead, and none carries a tooltip of reasons.
    expect(markup).not.toContain("disabled");
    expect(markup).not.toContain("title=");
  });

  it("highlights the active row", () => {
    const [first, second] = html(rows, 1).split("<button").slice(1);
    expect(first).not.toContain("bg-bg-active");
    expect(second).toContain("bg-bg-active");
  });

  it("runs the row on mousedown, so the textarea keeps its focus", () => {
    const onRun = vi.fn();
    const tree = SlashMenu({ rows, active: 0, onRun, onHover: noop });
    // The handler is on the button: find it in the element tree instead of rendering into a DOM.
    const buttons: Array<{ props: { onMouseDown: (event: { preventDefault: () => void }) => void } }> = [];
    const collect = (node: unknown): void => {
      if (node == null || typeof node !== "object") return;
      const element = node as { type?: unknown; props?: { children?: unknown; onMouseDown?: unknown } };
      if (element.type === "button") buttons.push(element as never);
      const children = element.props?.children;
      if (Array.isArray(children)) children.forEach(collect);
      else collect(children);
    };
    collect(tree);
    const prevented = vi.fn();
    buttons[2]?.props.onMouseDown({ preventDefault: prevented });
    expect(prevented).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledWith(rows[2]);
  });
});

describe("modeRows", () => {
  const pick = vi.fn();
  const ids = (options: Parameters<typeof modeRows>[0]) => modeRows(options).map((row) => row.id);

  it("offers both modes when the engine has Plan and nothing is running", () => {
    expect(ids({ mode: "agent", planSupported: true, canLeaveMode: true, onPick: pick })).toEqual(["agent", "plan"]);
  });

  it("leaves Plan out on an engine that cannot be held to read-only — no dead row, no reason", () => {
    const rows = modeRows({ mode: "agent", planSupported: false, canLeaveMode: true, onPick: pick });
    expect(rows.map((row) => row.id)).toEqual(["agent"]);
    expect(JSON.stringify(rows)).not.toContain("不支持");
  });

  it("offers nothing but the mode already in force while a turn runs", () => {
    expect(ids({ mode: "agent", planSupported: true, canLeaveMode: false, onPick: pick })).toEqual(["agent"]);
    expect(ids({ mode: "plan", planSupported: true, canLeaveMode: false, onPick: pick })).toEqual(["plan"]);
  });

  it("marks the mode in force, files the rows under 模式, and picks through the callback", () => {
    const rows = modeRows({ mode: "plan", planSupported: true, canLeaveMode: true, onPick: pick });
    expect(rows.map((row) => [row.id, row.selected, row.section])).toEqual([
      ["agent", false, "模式"],
      ["plan", true, "模式"],
    ]);
    rows[0]?.run();
    expect(pick).toHaveBeenCalledWith("agent");
  });

  it("is searchable like any other rows", () => {
    const rows = modeRows({ mode: "agent", planSupported: true, canLeaveMode: true, onPick: pick });
    expect(matchSlash(rows, "pl").map((row) => row.id)).toEqual(["plan"]);
  });

  it("keeps the chip's tooltip texts for the modes", () => {
    expect(MODES.map((entry) => entry.label)).toEqual(["Agent", "Plan"]);
  });
});
