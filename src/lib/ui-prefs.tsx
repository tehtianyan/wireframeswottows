import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { DEFAULT_SKIN, isSkinKey, type SkinKey } from "./skins";

export type ThemeMode = "dark" | "light";

type UiPrefs = {
  theme: ThemeMode;
  toggleTheme: () => void;
  /**
   * The active skin. INDEPENDENT of `theme`: each skin defines both a night and
   * a day palette in styles.css, so changing one never disturbs the other.
   */
  skin: SkinKey;
  setSkin: (skin: SkinKey) => void;
  showBuildStatus: boolean;
  toggleBuildStatus: () => void;
};

const UiPrefsContext = createContext<UiPrefs | null>(null);

const THEME_KEY = "swot-console-theme";
const SKIN_KEY = "swot-console-skin";
const BUILD_KEY = "swot-console-build-status";

export function UiPrefsProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [skin, setSkin] = useState<SkinKey>(DEFAULT_SKIN);
  const [showBuildStatus, setShowBuildStatus] = useState(true);

  // Read persisted prefs after hydration to avoid SSR mismatches.
  useEffect(() => {
    const storedTheme = localStorage.getItem(THEME_KEY);
    if (storedTheme === "light" || storedTheme === "dark") setTheme(storedTheme);
    // Validated rather than cast: a skin that no longer exists would leave the
    // document carrying a data-skin with no CSS behind it, which renders as
    // the default anyway but makes the picker show a selection that is not
    // really applied.
    const storedSkin = localStorage.getItem(SKIN_KEY);
    if (isSkinKey(storedSkin)) setSkin(storedSkin);
    const storedBuild = localStorage.getItem(BUILD_KEY);
    if (storedBuild === "off") setShowBuildStatus(false);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("light", theme === "light");
    root.classList.toggle("dark", theme === "dark");
    root.style.colorScheme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  // Separate effect from the theme on purpose. The two axes are written to
  // different attributes and must not be able to clobber one another.
  useEffect(() => {
    document.documentElement.dataset["skin"] = skin;
    localStorage.setItem(SKIN_KEY, skin);
  }, [skin]);

  useEffect(() => {
    document.documentElement.dataset["buildStatus"] = showBuildStatus ? "on" : "off";
    localStorage.setItem(BUILD_KEY, showBuildStatus ? "on" : "off");
  }, [showBuildStatus]);

  return (
    <UiPrefsContext.Provider
      value={{
        theme,
        toggleTheme: () => setTheme((t) => (t === "dark" ? "light" : "dark")),
        skin,
        setSkin,
        showBuildStatus,
        toggleBuildStatus: () => setShowBuildStatus((v) => !v),
      }}
    >
      {children}
    </UiPrefsContext.Provider>
  );
}

export function useUiPrefs() {
  const ctx = useContext(UiPrefsContext);
  if (!ctx) throw new Error("useUiPrefs must be used inside UiPrefsProvider");
  return ctx;
}
