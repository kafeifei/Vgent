import { describe, expect, it } from "vitest";
import { CENTER_MIN, PANE_MIN, clampPaneWidth, fitPaneWidths, parsePaneWidths } from "./paneWidths";

describe("clampPaneWidth", () => {
  it("stops at the column's minimum", () => {
    expect(clampPaneWidth("left", 50, 1400, 420)).toBe(PANE_MIN.left);
    expect(clampPaneWidth("rightPane", 100, 1400, 260)).toBe(PANE_MIN.rightPane);
  });

  it("leaves the conversation its room", () => {
    expect(clampPaneWidth("left", 900, 1400, 420)).toBe(1400 - 420 - CENTER_MIN);
    expect(clampPaneWidth("left", 300.4, 1400, 420)).toBe(300);
  });

  it("never goes under the minimum, even in a window too small for everything", () => {
    expect(clampPaneWidth("rightPane", 500, 900, 260)).toBe(PANE_MIN.rightPane);
  });
});

describe("fitPaneWidths", () => {
  it("fits dragged widths to the window and leaves undragged columns to their tokens", () => {
    expect(fitPaneWidths({ left: 500, rightPane: 700 }, 2000, { left: true, right: "rightPane" })).toEqual({ left: 500, rightPane: 700 });
    // 1200 wide: the right pane gives way first, then the sidebar takes what is left.
    expect(fitPaneWidths({ left: 500, rightPane: 700 }, 1200, { left: true, right: "rightPane" })).toEqual({ left: 460, rightPane: 320 });
    expect(fitPaneWidths({ rightList: 300 }, 1400, { left: true, right: "rightPane" })).toEqual({});
    expect(fitPaneWidths({ left: 1200 }, 1400, { left: true, right: null })).toEqual({ left: 1400 - CENTER_MIN });
  });

  it("fits default panes too, including a mixed default and dragged layout", () => {
    expect(fitPaneWidths({}, 971, { left: true, right: "rightPane" })).toEqual({ left: 231, rightPane: 320 });
    expect(fitPaneWidths({ rightPane: 500 }, 971, { left: true, right: "rightPane" })).toEqual({ left: 231, rightPane: 320 });
    expect(fitPaneWidths({ left: 500 }, 1200, { left: true, right: "rightPane" })).toEqual({ left: 460, rightPane: 320 });
  });

  it("uses the current density's tokens and restores them in a larger window", () => {
    const compact = { left: 236, rightList: 260, rightPane: 420 };
    expect(fitPaneWidths({}, 1000, { left: true, right: "rightPane" }, compact)).toEqual({ rightPane: 344 });
    expect(fitPaneWidths({}, 1200, { left: true, right: "rightPane" }, compact)).toEqual({});
    expect(fitPaneWidths({}, 800, { left: false, right: "rightPane" }, compact)).toEqual({ rightPane: 380 });
    expect(fitPaneWidths({}, 800, { left: true, right: "rightList" }, compact)).toEqual({ left: 200, rightList: 200 });
  });

  it("keeps pane minimums when the window cannot fit all three columns", () => {
    expect(fitPaneWidths({}, 800, { left: true, right: "rightPane" })).toEqual({ left: 200, rightPane: 320 });
  });
});

describe("parsePaneWidths", () => {
  it("keeps what is a usable width and drops the rest", () => {
    expect(parsePaneWidths('{"left":300,"rightPane":10,"rightList":"x","other":500}')).toEqual({ left: 300 });
    expect(parsePaneWidths("not json")).toEqual({});
    expect(parsePaneWidths(null)).toEqual({});
  });
});
