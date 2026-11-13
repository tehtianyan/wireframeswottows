import { useEffect } from "react";

// Printing swaps the app to its existing light palette for the duration of
// the print, then restores whatever the user had.
//
// This reuses the theme system in `ui-prefs.tsx`, which already toggles
// `.light` / `.dark` on the root element and already has a full light palette
// defined in styles.css. Doing it this way rather than overriding colour
// tokens inside `@media print` matters: Tailwind's `dark:` variants key off an
// ancestor `.dark` class, not a media query, so a media-query-only approach
// would leave every `dark:` utility firing on white paper.
//
// It reads the LIVE class rather than the default, which is why it kept
// working when the default became day on 2026-11-14: somebody who has chosen
// dark still gets paper rather than a page of black ink, and somebody already
// in day mode is left alone instead of being toggled twice.
export function usePrintTheme() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const root = document.documentElement;
    let wasDark = false;

    const before = () => {
      wasDark = root.classList.contains("dark");
      if (wasDark) {
        root.classList.remove("dark");
        root.classList.add("light");
      }
    };
    const after = () => {
      if (wasDark) {
        root.classList.remove("light");
        root.classList.add("dark");
      }
    };

    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);

    // Safari and some mobile browsers fire only the media-query change.
    const mql = window.matchMedia("print");
    const onChange = (e: MediaQueryListEvent) => (e.matches ? before() : after());
    mql.addEventListener?.("change", onChange);

    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
      mql.removeEventListener?.("change", onChange);
      // If the component unmounts mid-print, do not strand the user in light.
      after();
    };
  }, []);
}
