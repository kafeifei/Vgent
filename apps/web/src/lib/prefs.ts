import { useCallback, useSyncExternalStore } from "react";

/**
 * Theme and density live on `<html>` as `data-theme` / `data-density`, exactly
 * like the prototype, and are mirrored into `localStorage`. The bootstrap
 * script in `index.html` applies them before first paint; this module is only
 * the runtime toggle.
 *
 * Dark is the default and is never written; only `"light"` is stored.
 */
export type Theme = "dark" | "light";
export type Density = "comfortable" | "compact";

const THEME_KEY = "vgent.theme";
const DENSITY_KEY = "vgent.density";

const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of [...listeners]) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const root = () => document.documentElement;

function readTheme(): Theme {
  return root().dataset.theme === "light" ? "light" : "dark";
}

function readDensity(): Density {
  return root().dataset.density === "compact" ? "compact" : "comfortable";
}

export function setTheme(theme: Theme): void {
  if (theme === "light") root().dataset.theme = "light";
  else delete root().dataset.theme;
  try {
    if (theme === "light") localStorage.setItem(THEME_KEY, "light");
    else localStorage.removeItem(THEME_KEY);
  } catch {
    /* private mode: the in-memory attribute is still correct */
  }
  emit();
}

export function setDensity(density: Density): void {
  root().dataset.density = density;
  try {
    localStorage.setItem(DENSITY_KEY, density);
  } catch {
    /* ignore */
  }
  emit();
}

export function usePrefs(): {
  theme: Theme;
  density: Density;
  toggleTheme: () => void;
  toggleDensity: () => void;
} {
  const theme = useSyncExternalStore(subscribe, readTheme, () => "dark" as Theme);
  const density = useSyncExternalStore(subscribe, readDensity, () => "comfortable" as Density);
  const toggleTheme = useCallback(() => setTheme(readTheme() === "light" ? "dark" : "light"), []);
  const toggleDensity = useCallback(
    () => setDensity(readDensity() === "compact" ? "comfortable" : "compact"),
    [],
  );
  return { theme, density, toggleTheme, toggleDensity };
}
