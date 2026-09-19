/**
 * Whether the page sits under the desktop shell's overlay title bar on macOS.
 * There the traffic lights are drawn on top of the page's top-left corner, so
 * whatever is there has to leave `--spacing-traffic` free and let the window be
 * dragged by it. A plain browser tab has neither.
 */
export function hasTrafficLights(): boolean {
  const host = globalThis as { __TAURI__?: unknown; navigator?: { platform?: string; userAgent?: string } };
  if (host.__TAURI__ == null) return false;
  return /Mac/i.test(host.navigator?.platform ?? host.navigator?.userAgent ?? "");
}
