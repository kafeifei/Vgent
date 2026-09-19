import { setDensity, setTheme, usePrefs, type Density, type Theme } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { SettingsGroup, SettingsRow } from "./layout";
import { PILL, PILL_SELECTED } from "./styles";

const THEMES: ReadonlyArray<{ id: Theme; label: string }> = [
  { id: "dark", label: "深色" },
  { id: "light", label: "浅色" },
];

const DENSITIES: ReadonlyArray<{ id: Density; label: string; hint: string }> = [
  { id: "comfortable", label: "舒适", hint: "默认" },
  { id: "compact", label: "紧凑", hint: "一屏更多信息" },
];

/**
 * 外观: 主题 and 密度, moved off the title bar. Unlike everything else on this
 * page they take effect — and are stored on the server — the moment they are
 * clicked, with no 保存: you are looking at the result while you choose, and a
 * 保存 you might not press would make the screen lie about what is stored.
 *
 * That is also why the page's 保存 never sends these two fields: it holds a
 * snapshot from when it was opened, and sending it back would undo a theme
 * picked since.
 */
export function AppearanceSection() {
  const { theme, density } = usePrefs();

  return (
    <SettingsGroup note="点了就生效，也当场存在 server 上，不用按保存。">
      <SettingsRow title="主题">
        {THEMES.map((entry) => (
          <button key={entry.id} type="button" aria-pressed={theme === entry.id} onClick={() => setTheme(entry.id)} className={cn(PILL, theme === entry.id && PILL_SELECTED)}>
            {entry.label}
          </button>
        ))}
      </SettingsRow>
      <SettingsRow title="密度" help="紧凑：一屏更多信息。">
        {DENSITIES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-pressed={density === entry.id}
            title={entry.hint}
            onClick={() => setDensity(entry.id)}
            className={cn(PILL, density === entry.id && PILL_SELECTED)}
          >
            {entry.label}
          </button>
        ))}
      </SettingsRow>
    </SettingsGroup>
  );
}
