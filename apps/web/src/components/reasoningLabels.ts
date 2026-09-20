/**
 * The level names every engine speaks, in Chinese. `low` … `max` are shared by
 * Codex's own catalog, the gateway and the Claude Code harness's `effort`;
 * `disabled`/`adaptive`/`enabled` only label what an older build stored. A
 * level nobody here knows shows its raw id rather than nothing.
 */
const LEVEL_LABELS: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
  ultra: "极致",
  none: "关",
  "provider-default": "不指定",
  minimal: "极低",
  disabled: "关",
  adaptive: "自适应",
  enabled: "开",
};

export const reasoningLabel = (level: string): string => LEVEL_LABELS[level] ?? level;
