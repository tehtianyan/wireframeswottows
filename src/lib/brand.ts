// The brand — ONE owner for every surface that names or marks the product.
//
// Before this module the brand lived in five places that had to be found
// separately: the header mark and wordmark, the sign-in heading, the favicon
// link, the (missing) document title, and the exported report's cover. Four of
// them are easy to miss, which is how a rebrand ends up half-applied — a new
// name in the header and the old one on the report that reaches the client.
//
// TWO LAYERS, AND THE ORDER MATTERS:
//
//  1. BUILD-TIME (here). VITE_BRAND_* is inlined into the bundle, so this is
//     one brand per deployment. It is what the SIGN-IN page uses, because
//     nothing per-organization can be resolved before anyone is signed in.
//  2. RUNTIME (useBrand). Once signed in, GET /branding resolves the
//     organization's own name and logo and overlays this. That is the
//     white-label layer, maintained from /admin with no deploy.
//
// A brand overrides IDENTITY ONLY — name and logo. Colour is deliberately NOT
// here: one client hex against five skins x two modes is ten combinations
// where contrast can silently fail, and skins.js exists precisely because a
// palette problem reads as a rendering bug. If a client colour is ever wanted
// it should arrive as a generated skin, through the mechanism that already
// asserts a complete token set in both modes.

export interface Brand {
  /** Full product name: the sign-in heading and the document title. */
  name: string;
  /** Short form for the header beside the mark, where space is tight. */
  shortName: string;
  /** A logo image, or null to render the initials mark instead. */
  logoUrl: string | null;
  /** The fallback mark. 1-3 characters; more will not fit the 32px tile. */
  initials: string;
  /**
   * Alt text. A logo that names the product is CONTENT, not decoration, so
   * it gets a real description rather than alt="".
   */
  logoAlt: string;
  /**
   * Whether the header prints `shortName` beside the mark.
   *
   * THE RULE: explicit text is always honoured; IMPLIED text is suppressed
   * when a logo already speaks for the product.
   *
   *   logo + a display name you typed  -> logo AND the name
   *   logo + no display name           -> logo alone
   *   no logo + a display name         -> initials AND the name
   *   no logo + no display name        -> initials AND the organization name
   *
   * The first line is a BUG FIX. This used to be `!logoUrl`, on the theory
   * that a logo is a wordmark and printing the name beside it double-brands.
   * That is true of some logos and false of every symbol mark — and, far
   * worse, it meant the Display Name field silently did nothing as soon as a
   * logo was uploaded. A field that quietly stops working depending on
   * another field is exactly the silent no-op this codebase keeps deleting.
   * A client whose logo IS a wordmark now simply leaves Display Name empty.
   */
  showWordmark: boolean;
}

const env = import.meta.env as Record<string, string | undefined>;

function fromEnv(key: string, fallback: string): string {
  const v = env[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : fallback;
}

/**
 * The deployment's brand. Overridable per environment without touching code:
 *
 *   VITE_BRAND_NAME="Acme Strategy Console"
 *   VITE_BRAND_SHORT_NAME="Acme"
 *   VITE_BRAND_INITIALS="AC"
 *   VITE_BRAND_LOGO_URL="/brand/acme.png"
 *
 * Note for Vercel: VITE_-prefixed variables are rejected at "sensitive"
 * visibility, so add these with --no-sensitive. They are public by design —
 * they ship in the browser bundle.
 */
const buildLogo = env["VITE_BRAND_LOGO_URL"]?.trim() || null;
// Was a name GIVEN, as opposed to defaulted? Same question the organization
// layer asks of display_name, and it gets the same answer.
const buildNameGiven =
  (env["VITE_BRAND_NAME"]?.trim() ?? "") !== "" ||
  (env["VITE_BRAND_SHORT_NAME"]?.trim() ?? "") !== "";

export const BUILD_BRAND: Brand = {
  name: fromEnv("VITE_BRAND_NAME", "SWOT·TOWS Strategy Console"),
  shortName: fromEnv("VITE_BRAND_SHORT_NAME", "SWOT·TOWS Console"),
  initials: fromEnv("VITE_BRAND_INITIALS", "ST").slice(0, 3),
  logoUrl: buildLogo,
  logoAlt: fromEnv("VITE_BRAND_NAME", "SWOT·TOWS Strategy Console"),
  showWordmark: !buildLogo || buildNameGiven,
};

/** What GET /branding returns. Empty strings mean "not set" — the FALLBACK is
 *  decided here rather than by the server, because it differs per surface:
 *  the header falls back to initials, the report cover to no logo at all. */
export interface OrgBranding {
  organization_id: string;
  name: string;
  display_name: string;
  logo_data_uri: string;
  logo_filename: string;
}

/**
 * Overlay an organization's branding on the deployment default.
 *
 * Pure, and exported so the admin page's preview and the live header render
 * through exactly the same function. A preview that computed the result
 * differently from the real thing would be worse than no preview — it would
 * be a confident wrong answer.
 */
export function resolveBrand(org: OrgBranding | null | undefined): Brand {
  if (!org || !org.organization_id) return BUILD_BRAND;

  // display_name is the white-label product name somebody TYPED; the
  // organization's own name is the sensible second choice, since it is always
  // present. Which of the two we ended up with decides whether the header
  // prints it beside a logo — see Brand.showWordmark.
  const typed = org.display_name.trim();
  const name = typed || org.name.trim() || BUILD_BRAND.name;
  const logo = org.logo_data_uri.trim() || null;

  return {
    name,
    shortName: name,
    logoUrl: logo,
    // Initials are only a fallback for a MISSING logo, so they derive from
    // the brand that is actually in force.
    initials: logo ? "" : initialsFor(name),
    logoAlt: name,
    showWordmark: !logo || typed !== "",
  };
}

/**
 * Initials from a name: first letters of the first two words, or the first
 * two characters of a single word. "Acme Group" -> "AG", "Northwind" -> "NO".
 */
export function initialsFor(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return BUILD_BRAND.initials;
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}
