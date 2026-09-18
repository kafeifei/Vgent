/**
 * True for a key event that belongs to an input method (拼音、日文假名…), not
 * to us. `isComposing` alone is not enough: WebKit — which is what the desktop
 * shell's WKWebView is — fires `compositionend` *before* the Enter that
 * confirmed the candidate, so that keydown arrives with `isComposing: false`.
 * It still carries the legacy `keyCode` 229, which no real key produces.
 *
 * Every handler that acts on Enter / Escape / Tab / arrows in a text field
 * asks this first, or confirming a candidate sends the message.
 */
type KeyLike = { isComposing?: boolean; keyCode?: number };

/** Takes a DOM `KeyboardEvent` or a React synthetic one. */
export function isImeKeyEvent(event: KeyLike | { nativeEvent: KeyLike }): boolean {
  const native = "nativeEvent" in event ? event.nativeEvent : event;
  return native.isComposing === true || native.keyCode === 229;
}
