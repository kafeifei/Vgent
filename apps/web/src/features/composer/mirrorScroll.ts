import { useCallback, useEffect, useLayoutEffect, type RefObject } from "react";

/** What of the textarea the mirror layer has to follow. */
export interface ScrollSource {
  scrollTop: number;
  scrollLeft: number;
  offsetWidth: number;
  clientWidth: number;
}

export interface MirrorTarget {
  scrollTop: number;
  scrollLeft: number;
  style: { right: string };
}

/**
 * The composer draws its text twice: the textarea's own is transparent, and a
 * layer under it (the mirror) draws the same text with the `@` pills. Past the
 * textarea's `max-height` the textarea scrolls its content and the mirror, which
 * is clipped and cannot be scrolled by the user, stays at the top — a long paste
 * left the caret at the end of text that was not drawn there.
 *
 * This keeps the mirror where the textarea is: the same scroll offset, and — where
 * the scrollbar takes room from the text (classic scrollbars; overlay ones take none)
 * — the same text width, or the two would wrap differently and drift apart.
 */
export function syncMirror(source: ScrollSource, mirror: MirrorTarget): void {
  mirror.scrollTop = source.scrollTop;
  mirror.scrollLeft = source.scrollLeft;
  const gutter = source.offsetWidth - source.clientWidth;
  mirror.style.right = gutter > 0 ? `${gutter}px` : "";
}

/**
 * Keeps `mirror` on `textarea`: after every change of `value` (the browser may
 * have scrolled the caret into view), on every resize of the box (the pane
 * dragged, the window, the auto-grow), and — through the returned function — on
 * every scroll event. Wire that function to the textarea's `onScroll`.
 */
export function useMirrorScroll(
  textarea: RefObject<HTMLTextAreaElement | null>,
  mirror: RefObject<HTMLElement | null>,
  value: string,
): () => void {
  const sync = useCallback(() => {
    const source = textarea.current;
    const target = mirror.current;
    if (source != null && target != null) syncMirror(source, target);
  }, [textarea, mirror]);

  // Before paint: the frame that shows the new text shows it in the right place.
  useLayoutEffect(() => {
    sync();
  }, [sync, value]);

  useEffect(() => {
    const source = textarea.current;
    if (source == null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(source);
    return () => observer.disconnect();
  }, [textarea, sync]);

  return sync;
}
