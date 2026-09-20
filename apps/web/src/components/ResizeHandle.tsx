import { useRef } from "react";

/**
 * The seam between a side column and the conversation. Drag it to resize the
 * column; double-click it to give the column its designed width back. It sits
 * on the boundary rather than inside either column, and is a hair wider than
 * it looks so it can be caught.
 */
export function ResizeHandle({
  side,
  offset,
  onStart,
  onDrag,
  onEnd,
  onReset,
}: {
  /** Which edge of the window the column is on; `offset` is measured from there. */
  side: "left" | "right";
  /** The column's width as CSS — a token or a pixel value, whichever the grid is using. */
  offset: string;
  /** Returns the column's width at the moment the drag starts. */
  onStart: () => number;
  onDrag: (width: number) => void;
  onEnd: () => void;
  onReset: () => void;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title="拖动调整宽度，双击恢复"
      style={{ [side]: `calc(${offset} - 3px)` }}
      className="group/handle absolute top-0 bottom-0 z-3 w-1.5 cursor-col-resize touch-none select-none"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width: onStart() };
      }}
      onPointerMove={(event) => {
        if (drag.current == null) return;
        const moved = event.clientX - drag.current.x;
        onDrag(drag.current.width + (side === "left" ? moved : -moved));
      }}
      onPointerUp={() => {
        if (drag.current == null) return;
        drag.current = null;
        onEnd();
      }}
      onPointerCancel={() => {
        drag.current = null;
        onEnd();
      }}
      onDoubleClick={onReset}
    >
      <div className="mx-auto h-full w-px bg-transparent transition-colors duration-[var(--duration-fast)] group-hover/handle:bg-border-strong group-active/handle:bg-focus-ring" />
    </div>
  );
}
