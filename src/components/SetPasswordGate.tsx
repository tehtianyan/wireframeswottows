import { useEffect, useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { landedOnRecoveryLink } from "@/lib/recovery-landing";
import { authApi } from "@/lib/api";

// "Set your password" — the screen an invite link lands on.
//
// WHY IT EXISTS. An invite or reset link arrives as
// `.../#access_token=…&type=recovery`. The Supabase client picks that fragment
// up and establishes a session, so the person was already INSIDE the app — but
// nothing ever asked them to choose a password, so the one session the link
// granted was the only one they would ever get. Next visit they had no
// credential and no way to make one. The invite flow looked like it worked and
// did not.
//
// It also strips the fragment from the address bar. Until used, that token is a
// bearer credential for the account; leaving it in the URL leaves it in history
// and in anything that logs a referrer.

/** Removes the token fragment without reloading or adding a history entry. */
function stripHash() {
  if (typeof window === "undefined") return;
  if (!window.location.hash) return;
  const { pathname, search } = window.location;
  window.history.replaceState(null, "", pathname + search);
}

export function useRecoveryLanding() {
  // Read from the module-load snapshot, NOT from the URL now. By the time this
  // runs the fragment may already be gone — supabase-js removes it when it
  // exchanges the token — and asking too late is how this screen came to never
  // appear at all. See src/lib/recovery-landing.ts for the full account.
  const [needsPassword, setNeedsPassword] = useState(landedOnRecoveryLink);

  useEffect(() => {
    // Touching supabase.auth is what CONSTRUCTS the client, which is what
    // makes it read the fragment and establish the session. Doing it here,
    // with nothing stripped beforehand, is the fix: the client must see the
    // URL before anybody tidies it.
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") setNeedsPassword(true);
      // Tidy the address bar only once a session exists, i.e. once the token
      // has been exchanged and is spent. Stripping before that threw away the
      // credential unused. It is worth stripping at all because until it is
      // used the token is a bearer credential for the account, and the URL
      // ends up in history and in anything that logs a referrer — supabase-js
      // normally clears it itself, so this is a safety net rather than the
      // mechanism.
      if (session) stripHash();
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return { needsPassword, done: () => setNeedsPassword(false) };
}

export function SetPasswordScreen({
  email,
  onDone,
  firstTime = true,
}: {
  email?: string;
  onDone: () => void;
  /**
   * Whether this is a first password or a replacement. Wording only — the
   * server decided which credential it minted, and `flow` in the URL is not
   * authority (see recovery-landing). A returning user told "welcome, you are
   * now a participant" would be confused; a new one told "your password has
   * been changed" would wonder what it was before.
   */
  firstTime?: boolean;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  // Supabase's own default minimum is 6; stating it here means the person is
  // told before submitting rather than by a server error afterwards.
  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && password !== confirm;
  const ready = password.length >= 8 && password === confirm && !saving;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setSaving(true);
    const { error } = await supabase.auth.updateUser({ password });
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }

    // THE CONFIRMATION EMAIL (item 5). Setting a password on a one-time link
    // is the moment somebody becomes a participant, and nothing confirmed it:
    // they were left wondering whether the link had worked, with no ordinary
    // sign-in URL to keep — the invitation link deliberately is not one.
    //
    // Deliberately NOT awaited before letting them in, and its failure is
    // swallowed on purpose. Their password IS set and they ARE signed in; an
    // error here would make a successful onboarding look broken, which is a
    // worse outcome than a missing reassurance. The server records every
    // attempt in email_deliveries, so a silent failure is still visible to an
    // administrator rather than to nobody.
    void authApi.confirmPasswordSet().catch(() => {});

    toast.success(
      firstTime
        ? "Password set — welcome. You are signed in."
        : "Password changed. You are signed in.",
    );
    onDone();
  }

  return (
    <div className="grid-backdrop flex min-h-screen items-center justify-center bg-background px-4">
      <form className="console-panel w-full max-w-sm space-y-4 p-6" onSubmit={submit}>
        <div>
          <div className="mb-2 inline-flex items-center gap-1.5 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            <KeyRound className="size-3" />
            One-time link
          </div>
          <h1 className="font-display text-lg font-semibold">
            {firstTime ? "Choose a password" : "Choose a new password"}
          </h1>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {email ? (
              <>
                You are signed in as <span className="text-foreground">{email}</span>. Set a
                password so you can sign in again later — this link only works once.
              </>
            ) : (
              <>
                Set a password so you can sign in again later — this link only works once.
              </>
            )}
          </p>
        </div>

        <div className="space-y-1.5">
          <p className="label-caps">New password</p>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
            autoComplete="new-password"
            aria-describedby="pw-hint"
          />
          <p id="pw-hint" className="text-[11px] text-muted-foreground">
            {tooShort ? (
              <span className="text-destructive">At least 8 characters.</span>
            ) : (
              "At least 8 characters."
            )}
          </p>
        </div>

        <div className="space-y-1.5">
          <p className="label-caps">Confirm</p>
          <Input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            autoComplete="new-password"
          />
          {mismatch && <p className="text-[11px] text-destructive">These do not match.</p>}
        </div>

        <Button type="submit" className="w-full" disabled={!ready}>
          {saving && <Loader2 className="size-3.5 animate-spin" />}
          Set password and continue
        </Button>

        {/* Deliberately NOT offered as a skip. Somebody who dismisses this has
            exactly one session and no way back in, which is the bug this
            screen exists to close. */}
        <p className="text-center text-[11px] leading-snug text-muted-foreground">
          Until you set one, this is the only session this link gives you.
        </p>
      </form>
    </div>
  );
}
