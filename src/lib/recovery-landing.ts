// How did this page load? Answered ONCE, at module load, and never re-read.
//
// That is the whole point of the file. The evidence lives in the URL, and the
// URL is rewritten by whoever gets to it first — supabase-js removes the hash
// as part of detectSessionInUrl, and any code of ours that tidies the address
// bar removes it too. A question answered later is a question answered after
// the evidence has been cleared away.
//
// THE BUG THIS EXISTS TO PREVENT. The check used to live in a React effect
// that detected the fragment and immediately stripped it. The Supabase client
// is constructed lazily, on first property access, and that first access came
// AFTER the strip — so the client was handed a URL with no token in it. It
// never established a session, the auth gate fell through to "not signed in",
// and the invitee landed on the sign-in page needing the very password the
// link existed to let them choose. Both halves looked correct in isolation;
// the order was what was wrong, and nothing about the order was obvious.
//
// Everything below follows that one rule, including the two readers added for
// the app-hosted link, where nothing would strip the query — the rule is
// uniform so the next reader cannot get it wrong by being written differently.

const initialHash = typeof window === "undefined" ? "" : window.location.hash;
const initialSearch = typeof window === "undefined" ? "" : window.location.search;

// Both invite and reset links carry `type=recovery`, because the server mints
// both through GoTrue's recovery endpoint — `invite` is refused for an account
// that already exists. `type=invite` is matched too, for links minted anywhere
// else. See pkg/supaadmin.SignInLinkFor.
const landed = /\btype=(recovery|invite)\b/.test(initialHash);

/** True when this page load came from an invite or password-reset link. */
export function landedOnRecoveryLink(): boolean {
  return landed;
}

/** What an app-hosted link carries. See pkg/supaadmin.AppVerifyURL. */
export type RecoveryToken = {
  tokenHash: string;
  /** The exchange type verifyOtp needs. Always `recovery` in practice. */
  type: "recovery" | "invite";
  /**
   * Wording only — a first-timer is choosing a password, a returning user is
   * replacing one. It carries NO authority: it is in a URL the recipient can
   * edit, and editing it changes the heading and nothing else.
   */
  flow: "invite" | "reset";
};

const params = new URLSearchParams(initialSearch);

const tokenHash = params.get("token_hash") ?? "";
const tokenType = params.get("type") === "invite" ? "invite" : "recovery";
const tokenFlow = params.get("flow") === "invite" ? "invite" : "reset";

/**
 * The one-time credential from an app-hosted link, or null.
 *
 * WHY THE TOKEN IS IN THE QUERY AND NOT THE FRAGMENT. A fragment is consumed
 * by supabase-js automatically, which means the credential is spent by the
 * page merely LOADING — and the page loads for every link scanner, prefetcher
 * and click-tracker between the sender and the reader. Here nothing is spent
 * until the app calls verifyOtp, which is a POST that only a real browser
 * running the app will make.
 */
export function recoveryTokenFromURL(): RecoveryToken | null {
  if (!tokenHash) return null;
  return { tokenHash, type: tokenType, flow: tokenFlow };
}

/** A failure GoTrue reported by redirecting, rather than by an HTTP error. */
export type LinkFailure = { code: string; description: string };

/**
 * The error a spent, expired or tampered link arrives with.
 *
 * THIS IS THE REPORTED DEFECT'S SECOND HALF. A one-time link that has already
 * been used redirects to
 *
 *   https://site/#error=access_denied&error_code=otp_expired&error_description=...
 *
 * which carries no `type=recovery` — so `landedOnRecoveryLink()` was false,
 * there was no session, and the app showed a bare sign-in form. The person had
 * clicked an invitation and been asked, with no explanation whatsoever, for a
 * password they had never set. The information needed to explain it was in the
 * URL the whole time and nothing read it.
 *
 * Read from the hash AND the query, because which one carries it depends on
 * the flow and guessing wrong means saying nothing again.
 */
export function linkFailureFromURL(): LinkFailure | null {
  const hash = new URLSearchParams(initialHash.replace(/^#/, ""));
  const code = hash.get("error_code") ?? params.get("error_code") ?? "";
  const generic = hash.get("error") ?? params.get("error") ?? "";
  if (!code && !generic) return null;
  const description =
    hash.get("error_description") ?? params.get("error_description") ?? "";
  return { code: code || generic, description: description.replace(/\+/g, " ") };
}

/**
 * What to tell somebody whose link did not work, in their terms.
 *
 * `otp_expired` covers BOTH "used already" and "too old", and the distinction
 * matters to the reader: a link that a corporate mail scanner opened before
 * they did is spent through no fault of theirs, and "ask for a fresh one" is
 * the only useful instruction either way. Phrased so it does not accuse them
 * of having already used it.
 */
export function explainLinkFailure(f: LinkFailure): string {
  if (f.code === "otp_expired" || f.code === "access_denied") {
    // No "below". The actions sit beside this sentence on the /welcome
    // screen and above it in the sign-in panel, so a direction would be wrong
    // in one of the two places — found by looking at the screenshot, which no
    // assertion would have.
    return (
      "That link no longer works. A one-time link expires once it is opened — " +
      "and some corporate mail systems open links automatically before you do, " +
      "which uses it up. Ask whoever invited you to send another, or request " +
      "one yourself."
    );
  }
  return f.description
    ? `That link could not be used: ${f.description}`
    : "That link could not be used. Ask whoever invited you to send another.";
}
