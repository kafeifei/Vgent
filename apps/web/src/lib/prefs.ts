import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { Settings, UiDensity, UiTheme } from "./types";

/**
 * Theme and density live on `<html>` as `data-theme` / `data-density`, exactly
 * like the prototype. The *stored* copy is the server's (`Settings.theme` /
 * `Settings.density`): the desktop shell's WebView gets a new origin on every
 * launch, so `localStorage` alone would forget them. The local copy stays only
 * so the bootstrap script in `index.html` can paint the right theme before the
 * first server response.
 *
 * `data-theme-preference` keeps the selected mode; `data-theme` is its resolved
 * appearance. Dark is the default; the local cache stores light and system.
 */
export type Theme = UiTheme;
export type Density = UiDensity;

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

/** Set while the server's own value is being applied, so it is not sent straight back. */
let applying = false;
/** Registered by `usePrefsSync`; absent before the workbench mounts. */
let push: ((prefs: { theme: Theme; density: Density }) => void) | undefined;

const root = () => document.documentElement;

function readTheme(): Theme {
  const preference = root().dataset.themePreference;
  if (preference === "system" || preference === "light" || preference === "dark") return preference;
  return readResolvedTheme();
}

function readResolvedTheme(): "light" | "dark" {
  return root().dataset.theme === "light" ? "light" : "dark";
}

function applyTheme(theme: Theme): void {
  const light = theme === "light" || (theme === "system" && window.matchMedia("(prefers-color-scheme: light)").matches);
  if (light) root().dataset.theme = "light";
  else delete root().dataset.theme;
}

function readDensity(): Density {
  return root().dataset.density === "compact" ? "compact" : "comfortable";
}

/** Both values travel together, so the stored pair is always the one on screen. */
function persist(): void {
  if (applying) return;
  push?.({ theme: readTheme(), density: readDensity() });
}

export function setTheme(theme: Theme): void {
  root().dataset.themePreference = theme;
  applyTheme(theme);
  try {
    if (theme !== "dark") localStorage.setItem(THEME_KEY, theme);
    else localStorage.removeItem(THEME_KEY);
  } catch {
    /* private mode: the in-memory attribute is still correct */
  }
  persist();
  emit();
}

export function setDensity(density: Density): void {
  root().dataset.density = density;
  try {
    localStorage.setItem(DENSITY_KEY, density);
  } catch {
    /* ignore */
  }
  persist();
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
  const toggleTheme = useCallback(() => setTheme(readResolvedTheme() === "light" ? "dark" : "light"), []);
  const toggleDensity = useCallback(
    () => setDensity(readDensity() === "compact" ? "comfortable" : "compact"),
    [],
  );
  return { theme, density, toggleTheme, toggleDensity };
}

/**
 * Binds the two toggles to the server: every change is written to `Settings`,
 * and every snapshot is applied to `<html>`.
 *
 * The very first snapshot of a server that has never stored them adopts what
 * this browser had instead of resetting it — otherwise the move to the server
 * would silently throw the user's theme away once.
 */
export function usePrefsSync(settings: Settings | null, write: (prefs: { theme: Theme; density: Density }) => void): void {
  const writeRef = useRef(write);
  writeRef.current = write;
  useEffect(() => {
    push = (prefs) => writeRef.current(prefs);
    return () => {
      push = undefined;
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      if (readTheme() !== "system") return;
      // OS changes affect the appearance, never the stored preference.
      applyTheme("system");
    };
    media.addEventListener("change", onChange);
    onChange();
    return () => media.removeEventListener("change", onChange);
  }, []);

  // The snapshot object is new on every SSE event, so the effect watches the
  // two values it actually applies.
  const ready = settings != null;
  const theme = settings?.theme;
  const density = settings?.density;
  const seen = useRef(false);
  useEffect(() => {
    if (!ready) return;
    if (!seen.current) {
      seen.current = true;
      if (theme == null && density == null && (readTheme() !== "dark" || readDensity() !== "comfortable")) {
        writeRef.current({ theme: readTheme(), density: readDensity() });
        return;
      }
    }
    applying = true;
    try {
      setTheme(theme ?? "dark");
      setDensity(density ?? "comfortable");
    } finally {
      applying = false;
    }
  }, [density, ready, theme]);
}
