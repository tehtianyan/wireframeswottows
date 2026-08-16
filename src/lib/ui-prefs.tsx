import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type ThemeMode = "dark" | "light";

type UiPrefs = {
  theme: ThemeMode;
  toggleTheme: () => void;
  showBuildStatus: boolean;
  toggleBuildStatus: () => void;
};

const UiPrefsContext = createContext<UiPrefs | null>(null);

const THEME_KEY = "swot-console-theme";
const BUILD_KEY = "swot-console-build-status";

export function UiPrefsProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [showBuildStatus, setShowBuildStatus] = useState(true);

  // Read persisted prefs after hydration to avoid SSR mismatches.
  useEffect(() => {
    const storedTheme = localStorage.getItem(THEME_KEY);
    if (storedTheme === "light" || storedTheme === "dark") setTheme(storedTheme);
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

  useEffect(() => {
    document.documentElement.dataset["buildStatus"] = showBuildStatus ? "on" : "off";
    localStorage.setItem(BUILD_KEY, showBuildStatus ? "on" : "off");
  }, [showBuildStatus]);

  return (
    <UiPrefsContext.Provider
      value={{
        theme,
        toggleTheme: () => setTheme((t) => (t === "dark" ? "light" : "dark")),
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
