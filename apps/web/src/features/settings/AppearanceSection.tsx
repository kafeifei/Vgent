import { setDensity, setTheme, usePrefs, type Density, type Theme } from "@/lib/prefs";
import { Segmented, SettingsGroup, SettingsRow } from "./layout";

const THEMES: ReadonlyArray<{ id: Theme; label: string }> = [
  { id: "dark", label: "深色" },
  { id: "light", label: "浅色" },
  { id: "system", label: "跟随系统" },
];

const DENSITIES: ReadonlyArray<{ id: Density; label: string; title: string }> = [
  { id: "comfortable", label: "舒适", title: "默认" },
  { id: "compact", label: "紧凑", title: "一屏更多信息" },
];

/** Appearance preferences apply and persist on selection. */
export function AppearanceSection() {
  const { theme, density } = usePrefs();

  return (
    <SettingsGroup title="外观">
      <SettingsRow title="主题">
        <Segmented label="主题" value={theme} options={THEMES} onChange={setTheme} />
      </SettingsRow>
      <SettingsRow title="密度" help="紧凑：一屏更多信息。">
        <Segmented label="密度" value={density} options={DENSITIES} onChange={setDensity} />
      </SettingsRow>
    </SettingsGroup>
  );
}
