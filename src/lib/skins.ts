// The selectable skins.
//
// A skin repaints the console. It is ORTHOGONAL to the dark/day toggle: each
// skin defines both modes in styles.css, so switching skin keeps your mode and
// switching mode keeps your skin. Neither control overrides the other.
//
// "console" is the default and has NO block in styles.css — it is the `:root`
// and `.light` palettes the app has always had. Choosing it is the absence of
// an override, which is why it cannot drift out of step with itself.
//
// The swatches below are for the picker's preview only. They are literals
// because CSS custom properties cannot be read for a skin that is not
// currently applied, so they must be kept in step by hand with the
// corresponding block in styles.css — each entry names the mode it came from.

export type SkinKey = "console" | "boardroom" | "studio" | "signal" | "meridian";

export interface Skin {
  key: SkinKey;
  name: string;
  /** What this skin is FOR — shown in the picker, so the choice is informed. */
  description: string;
  /** background, primary, accent — from the skin's DARK block. */
  swatchDark: [string, string, string];
  /** background, primary, accent — from the skin's LIGHT block. */
  swatchLight: [string, string, string];
}

export const SKINS: Skin[] = [
  {
    key: "console",
    name: "Strategy Console",
    description: "Deep navy and cyan. The mission-control default.",
    swatchDark: ["oklch(0.19 0.026 258)", "oklch(0.76 0.13 196)", "oklch(0.79 0.15 78)"],
    swatchLight: ["oklch(0.97 0.006 250)", "oklch(0.55 0.12 214)", "oklch(0.7 0.14 66)"],
  },
  {
    key: "boardroom",
    name: "Boardroom",
    description: "Navy and brass. Understated and traditional, for a steering committee.",
    swatchDark: ["oklch(0.17 0.02 265)", "oklch(0.76 0.11 85)", "oklch(0.70 0.10 250)"],
    swatchLight: ["oklch(0.975 0.006 85)", "oklch(0.50 0.085 80)", "oklch(0.43 0.10 255)"],
  },
  {
    key: "studio",
    name: "Studio",
    description: "Ink on paper with a burnt-orange marker. Reads as workshop materials.",
    swatchDark: ["oklch(0.175 0.012 40)", "oklch(0.73 0.145 52)", "oklch(0.76 0.10 150)"],
    swatchLight: ["oklch(0.965 0.013 75)", "oklch(0.53 0.145 46)", "oklch(0.44 0.09 152)"],
  },
  {
    key: "signal",
    name: "Signal",
    description: "Neutral greys and one electric accent, so the data is the only colour.",
    swatchDark: ["oklch(0.165 0.004 285)", "oklch(0.71 0.18 295)", "oklch(0.81 0.15 95)"],
    swatchLight: ["oklch(0.98 0.002 285)", "oklch(0.51 0.20 295)", "oklch(0.56 0.13 85)"],
  },
  {
    key: "meridian",
    name: "Meridian",
    description: "Deep teal and sand. Suits operations and sustainability work.",
    swatchDark: ["oklch(0.175 0.022 195)", "oklch(0.77 0.12 172)", "oklch(0.81 0.12 72)"],
    swatchLight: ["oklch(0.97 0.009 170)", "oklch(0.46 0.095 175)", "oklch(0.53 0.105 68)"],
  },
];

export const DEFAULT_SKIN: SkinKey = "console";

export function isSkinKey(v: unknown): v is SkinKey {
  return typeof v === "string" && SKINS.some((s) => s.key === v);
}

export function skinByKey(key: SkinKey): Skin {
  return SKINS.find((s) => s.key === key) ?? SKINS[0]!;
}
