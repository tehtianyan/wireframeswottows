import { useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { SetPasswordScreen, useRecoveryLanding } from "@/components/SetPasswordGate";
import { BrandMark } from "@/components/BrandMark";
import { BUILD_BRAND } from "@/lib/brand";
import { explainLinkFailure, linkFailureFromURL } from "@/lib/recovery-landing";

export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  // An invite or reset link lands here with a token in the fragment. The client
  // turns that into a session, so without this the person would be dropped
  // straight into the app having never chosen a password — and the one session
  // the link granted would be the only one they ever got.
  const { needsPassword, done } = useRecoveryLanding();

  // Read from the module-load snapshot, like everything else about how this
  // page loaded — a spent link's error fragment is cleared by the same things
  // that clear the token. See src/lib/recovery-landing.ts.
  const linkFailure = linkFailureFromURL();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (session === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="grid-backdrop flex min-h-screen items-center justify-center bg-background px-4">
        <form
          className="console-panel w-full max-w-sm space-y-4 p-6"
          onSubmit={async (e) => {
            e.preventDefault();
            setLoading(true);
            const { error } = await supabase.auth.signInWithPassword({ email, password });
            setLoading(false);
            if (error) toast.error(error.message);
          }}
        >
          <div>
            {/* BUILD_BRAND, not the organization's. Nobody is signed in yet,
                so there is no organization to resolve one from — per-client
                branding on this screen needs the hostname, which is Tier 3.
                Using the deployment brand here is the honest answer rather
                than a flash of the wrong client's logo. */}
            {BUILD_BRAND.logoUrl && (
              <BrandMark brand={BUILD_BRAND} size={10} className="mb-3" />
            )}
            <h1 className="font-display text-lg font-semibold">{BUILD_BRAND.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">Sign in to continue.</p>
          </div>
          {/* THE LINK FAILED, AND NOW IT SAYS SO. Two different arrivals end
              up on this form with no password to offer:

              - `needsPassword` — a recovery fragment was present but no
                session came of it.
              - `linkFailure` — GoTrue redirected here with an explicit
                `error_code`, which is what a SPENT link produces. That
                fragment carries no `type=recovery`, so the first check cannot
                see it, and for a long time nothing read the error either.

              Either way the form is otherwise indistinguishable from a normal
              visit, so somebody who cannot possibly know their password was
              asked for it in silence. That silence IS the reported defect:
              "the link directed the participant to the login page without
              keying in their password". */}
          {(linkFailure || needsPassword) && (
            <div className="space-y-1.5 rounded-sm border border-warning/50 bg-warning/10 p-2">
              <p className="text-[11px] leading-snug">
                {linkFailure
                  ? explainLinkFailure(linkFailure)
                  : "That link did not sign you in — a one-time link works once and then expires."}
              </p>
              <Link
                to="/forgot-password"
                className="inline-block text-[11px] font-medium underline"
              >
                Email me a new link
              </Link>
            </div>
          )}
          <div className="space-y-1.5">
            <p className="label-caps">Email</p>
            <Input
              id="signin-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              autoComplete="email"
              /* NO SEEDED ADDRESS HERE. This placeholder read
                 "jane.smith@example.com" — a real demo account on the
                 PUBLIC production sign-in page, which both named an account
                 worth attacking and made the page look like a demo to a
                 client's staff. A placeholder's job is to show the shape of
                 the field, which this does without naming anybody. */
              placeholder="you@company.com"
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <p className="label-caps">Password</p>
              {/* The way back in, on the one screen where somebody discovers
                  they need it. Before this there was none: the page simply
                  asked again for the thing they did not know. */}
              <Link
                to="/forgot-password"
                className="text-[11px] text-muted-foreground underline hover:text-foreground"
              >
                Forgot your password?
              </Link>
            </div>
            <Input
              id="signin-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading && <Loader2 className="size-3.5 animate-spin" />}
            Sign in
          </Button>
          {/* DEV ONLY. This shipped ungated, so the PUBLIC production sign-in
              page printed the shared demo password next to a facilitator's
              address — anyone who found the URL could sign in as a facilitator
              and read every workshop. Convenient on dev, where the seeded
              accounts live and the data is disposable; indefensible in
              production. `vite build` runs in production mode, so the deployed
              bundle omits this entirely rather than merely hiding it. */}
          {/* The ADDRESS is gone from here too, not just from the
              placeholder. Naming a specific seeded account on a sign-in page
              is the habit worth dropping rather than the one rendering of it:
              the dev hint and the production placeholder were two copies of
              the same mistake, and only one of them was gated. The password
              stays, because on dev it is genuinely needed and the accounts are
              listed in the UAT scripts. */}
          {import.meta.env.MODE === "dev" && (
            <p className="text-center text-[11px] text-muted-foreground">
              Dev build — seeded accounts share the password{" "}
              <span className="font-mono">SwotDemo2026!</span>
            </p>
          )}
        </form>
      </div>
    );
  }

  // Checked AFTER the session exists, because the link has already signed them
  // in by this point — the question is not whether they are authenticated but
  // whether they hold a credential they can use again.
  if (needsPassword) {
    return <SetPasswordScreen {...(session.user?.email ? { email: session.user.email } : {})} onDone={done} />;
  }

  return <>{children}</>;
}
