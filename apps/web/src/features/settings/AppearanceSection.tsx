import { setDensity, setTheme, usePrefs, type Density, type Theme } from "@/lib/prefs";
import { Segmented, SettingsGroup, SettingsRow } from "./layout";

const THEMES: ReadonlyArray<{ id: Theme; label: string }> = [
  { id: "dark", label: "深色" },
  { id: "light", label: "浅色" },
];

const DENSITIES: ReadonlyArray<{ id: Density; label: string; title: string }> = [
  { id: "comfortable", label: "舒适", title: "默认" },
  { id: "compact", label: "紧凑", title: "一屏更多信息" },
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
    <SettingsGroup>
      <SettingsRow title="主题">
        <Segmented label="主题" value={theme} options={THEMES} onChange={setTheme} />
      </SettingsRow>
      <SettingsRow title="密度" help="紧凑：一屏更多信息。">
        <Segmented label="密度" value={density} options={DENSITIES} onChange={setDensity} />
      </SettingsRow>
    </SettingsGroup>
  );
}
