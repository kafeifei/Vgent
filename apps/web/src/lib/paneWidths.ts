/**
 * The two side columns can be dragged wider or narrower. A width is a
 * per-window convenience — it depends on the screen in front of you — so it
 * lives in this browser's storage, not on the server with the settings.
 */
export type PaneKey = "left" | "rightList" | "rightPane";

export type PaneWidths = Partial<Record<PaneKey, number>>;

/** Narrower than this and a column stops being usable: rows truncate to nothing, tabs wrap. */
export const PANE_MIN: Record<PaneKey, number> = { left: 200, rightList: 200, rightPane: 320 };

/** The conversation never gets squeezed below this by a side column. */
export const CENTER_MIN = 420;

/** What an undragged column takes, near enough to budget the other side against. */
const PANE_DEFAULT: Record<PaneKey, number> = { left: 260, rightList: 260, rightPane: 420 };

/**
 * The widths to lay out with, in a window of this size. A width dragged in a
 * large window is kept as it was asked for, and fitted each time — so making
 * the window small and large again gives the column back.
 */
export function fitPaneWidths(
  widths: PaneWidths,
  windowWidth: number,
  shown: { left: boolean; right: PaneKey | null },
): PaneWidths {
  const fitted: PaneWidths = {};
  const leftTaken = shown.left ? (widths.left ?? PANE_DEFAULT.left) : 0;
  if (shown.right != null && widths[shown.right] != null) {
    fitted[shown.right] = clampPaneWidth(shown.right, widths[shown.right] as number, windowWidth, leftTaken);
  }
  const rightTaken = shown.right == null ? 0 : (fitted[shown.right] ?? PANE_DEFAULT[shown.right]);
  if (shown.left && widths.left != null) fitted.left = clampPaneWidth("left", widths.left, windowWidth, rightTaken);
  return fitted;
}

const STORAGE_KEY = "vgent.layout.paneWidths";

/** `wanted`, kept between the column's minimum and what the window can spare. */
export function clampPaneWidth(key: PaneKey, wanted: number, windowWidth: number, otherSide: number): number {
  const most = Math.max(PANE_MIN[key], windowWidth - otherSide - CENTER_MIN);
  return Math.round(Math.min(Math.max(wanted, PANE_MIN[key]), most));
}

export function parsePaneWidths(raw: string | null): PaneWidths {
  if (raw == null) return {};
  try {
    const stored = JSON.parse(raw) as Record<string, unknown>;
    const widths: PaneWidths = {};
    for (const key of Object.keys(PANE_MIN) as PaneKey[]) {
      const value = stored[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= PANE_MIN[key]) widths[key] = value;
    }
    return widths;
  } catch {
    return {};
  }
}

export function loadPaneWidths(): PaneWidths {
  try {
    return parsePaneWidths(localStorage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

export function savePaneWidths(widths: PaneWidths): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // A full or disabled store only costs the memory of the width.
  }
}
