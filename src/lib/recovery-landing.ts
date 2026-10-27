// Did this page load from an invite or password-reset link?
//
// Answered ONCE, at module load, and never re-read. That is the whole point of
// the file: the answer is in `window.location.hash`, and the fragment is
// consumed and removed by whoever gets to it first — supabase-js removes it as
// part of detectSessionInUrl, and any code of ours that tidies the address bar
// removes it too. A question answered later is a question answered after the
// evidence has been cleared away.
//
// THE BUG THIS EXISTS TO PREVENT. The check used to live in a React effect
// that detected the fragment and immediately stripped it. The Supabase client
// is constructed lazily, on first property access, and that first access came
// AFTER the strip — so the client was handed a URL with no token in it. It
// never established a session, the auth gate fell through to "not signed in",
// and the invitee landed on the sign-in page needing the very password the
// link existed to let them choose. Both halves looked correct in isolation;
// the order was what was wrong, and nothing about the order was obvious.

const initialHash = typeof window === "undefined" ? "" : window.location.hash;

// Both invite and reset links carry `type=recovery`, because the server mints
// both through GoTrue's recovery endpoint — `invite` is refused for an account
// that already exists. `type=invite` is matched too, for links minted anywhere
// else. See pkg/supaadmin.SignInLinkFor.
const landed = /\btype=(recovery|invite)\b/.test(initialHash);

/** True when this page load came from an invite or password-reset link. */
export function landedOnRecoveryLink(): boolean {
  return landed;
}
