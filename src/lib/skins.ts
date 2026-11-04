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
// A skin carries THREE things, not one: its two faces, its corner radius and
// its two palettes. It was colour alone, and five palettes that differed only
// in hue were reported as indistinguishable — correctly, since they shared a
// ground lightness, a neutral chroma and a radius.
//
// The swatches and face names below are for the picker's preview only. They
// are literals because CSS custom properties cannot be read for a skin that is
// not currently applied, so they must be kept in step by hand with the
// corresponding block in styles.css — each entry names the mode it came from.

export type SkinKey = "console" | "boardroom" | "studio" | "signal" | "meridian";

export interface Skin {
  key: SkinKey;
  name: string;
  /** What this skin is FOR — shown in the picker, so the choice is informed. */
  description: string;
  /**
   * The display face, as a CSS font-family list. The picker sets its own name
   * in it, so choosing a skin shows you the type as well as the colour —
   * without it the typographic half of the choice is invisible until you
   * commit to it.
   */
  displayFamily: string;
  /** How the pairing is described in words, for the picker's second line. */
  typeNote: string;
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
    displayFamily: '"Source Serif 4", Georgia, serif',
    typeNote: "Source Serif 4 · Source Sans 3",
    swatchDark: ["oklch(0.19 0.026 258)", "oklch(0.76 0.13 196)", "oklch(0.79 0.15 78)"],
    swatchLight: ["oklch(0.97 0.006 250)", "oklch(0.55 0.12 214)", "oklch(0.7 0.14 66)"],
  },
  {
    key: "boardroom",
    name: "Boardroom",
    description: "Ink-navy and brass on ivory, with square corners. A printed board pack.",
    displayFamily: '"Libre Baskerville", Georgia, serif',
    typeNote: "Libre Baskerville · Libre Franklin",
    swatchDark: ["oklch(0.145 0.032 264)", "oklch(0.80 0.125 84)", "oklch(0.66 0.115 252)"],
    swatchLight: ["oklch(0.962 0.018 88)", "oklch(0.465 0.095 78)", "oklch(0.355 0.105 258)"],
  },
  {
    key: "studio",
    name: "Studio",
    description: "Warm kraft and cream, burnt orange, the roundest corners. Workshop materials.",
    displayFamily: '"Zilla Slab", Rockwell, Georgia, serif',
    typeNote: "Zilla Slab · Work Sans",
    swatchDark: ["oklch(0.215 0.030 42)", "oklch(0.745 0.165 50)", "oklch(0.755 0.105 152)"],
    swatchLight: ["oklch(0.948 0.030 84)", "oklch(0.525 0.165 44)", "oklch(0.425 0.095 152)"],
  },
  {
    key: "signal",
    name: "Signal",
    description: "True grey — no cast at all — one electric accent and hairline rules.",
    displayFamily: "Archivo, ui-sans-serif, system-ui, sans-serif",
    typeNote: "Archivo · IBM Plex Sans",
    swatchDark: ["oklch(0.125 0 0)", "oklch(0.705 0.205 296)", "oklch(0.835 0.165 92)"],
    swatchLight: ["oklch(1 0 0)", "oklch(0.49 0.215 296)", "oklch(0.545 0.14 84)"],
  },
  {
    key: "meridian",
    name: "Meridian",
    description: "Teal you can name, on mint paper, with sand. Operations and sustainability.",
    displayFamily: "Spectral, Georgia, serif",
    typeNote: "Spectral · Karla",
    swatchDark: ["oklch(0.168 0.045 194)", "oklch(0.805 0.145 168)", "oklch(0.845 0.135 74)"],
    swatchLight: ["oklch(0.958 0.026 172)", "oklch(0.445 0.105 172)", "oklch(0.505 0.115 66)"],
  },
];

export const DEFAULT_SKIN: SkinKey = "console";

export function isSkinKey(v: unknown): v is SkinKey {
  return typeof v === "string" && SKINS.some((s) => s.key === v);
}

export function skinByKey(key: SkinKey): Skin {
  return SKINS.find((s) => s.key === key) ?? SKINS[0]!;
}
