/** Formatting helpers shared by the sidebar, the work log and the palette. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "刚刚" / "12 分钟前" / "3 小时前" / "昨天 17:02" / "5 天前". */
export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const delta = Math.max(0, now - then);
  if (delta < MINUTE) return "刚刚";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} 分钟前`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)} 小时前`;
  if (delta < 2 * DAY) {
    const date = new Date(then);
    return `昨天 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  return `${Math.floor(delta / DAY)} 天前`;
}

/** The trailing path segment — what a tool row shows instead of a long path. */
export function baseName(path: string): string {
  const cleaned = path.replace(/[/\\]+$/, "");
  const slash = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  return slash >= 0 ? cleaned.slice(slash + 1) : cleaned;
}

/** Collapses whitespace and cuts to `max` characters with an ellipsis. */
export function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The title a thread gets from its first user message (server does the same). */
export function titleFromText(text: string, max = 60): string {
  const firstLine = text.split("\n", 1)[0]?.trim() ?? "";
  return firstLine.length > max ? firstLine.slice(0, max) : firstLine;
}
