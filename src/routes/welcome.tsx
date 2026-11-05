import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Loader2, MailWarning } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { SetPasswordScreen } from "@/components/SetPasswordGate";
import { BrandMark } from "@/components/BrandMark";
import { BUILD_BRAND } from "@/lib/brand";
import {
  explainLinkFailure,
  linkFailureFromURL,
  recoveryTokenFromURL,
} from "@/lib/recovery-landing";

// Where an invitation lands.
//
// WHY THIS PAGE EXISTS AT ALL — and it is the fix for the reported defect that
// "the Reset Password link directed the participant to the login page without
// keying in their password".
//
// GoTrue's own link is a GET to /auth/v1/verify, and ANY GET spends it.
// Outlook Safe Links, Gmail's prefetcher, antivirus gateways and an email
// provider's own click tracking all follow links in mail; each one burns a
// token that works exactly once. The invitee then clicks a dead link, GoTrue
// redirects to the site root with `#error=access_denied&error_code=otp_expired`
// — carrying no `type=recovery` — and the app, finding no session and no
// recovery marker, showed a bare sign-in form. They had been asked, with no
// explanation at all, for a password they had never set.
//
// So the link now points here, carrying the token HASH, and the credential is
// spent by the POST that verifyOtp makes. A scanner fetching this page gets
// HTML and consumes nothing. See pkg/supaadmin.AppVerifyURL.
//
// This route renders OUTSIDE AuthGate and AppShell (see __root.tsx): the
// person is not signed in yet, and showing them the product's navigation
// before they have a password would be showing them a door they cannot open.

export const Route = createFileRoute("/welcome")({
  component: WelcomePage,
});

type Phase = "exchanging" | "choose" | "failed" | "no-token";

function WelcomePage() {
  const navigate = useNavigate();
  const token = recoveryTokenFromURL();
  const failure = linkFailureFromURL();

  // ALWAYS "exchanging" ON THE FIRST RENDER, on the server and on the client
  // alike, and the real phase is decided in the effect below.
  //
  // This is not timidity about SSR, it is a visible bug otherwise. The route
  // is server-rendered, and on the server there is no `window`, so the token
  // is absent and `token ? … : "no-token"` chose the dead-end screen. React
  // then hydrated with the token present, the trees disagreed, and the invitee
  // got a flash of "Nothing to set up here" before the password form — which
  // reads exactly like the broken link this page exists to fix. Starting both
  // sides at the same neutral phase makes the first frame honest: it IS
  // checking.
  //
  // The module-load snapshot still holds: it is taken when the module loads in
  // the browser, long before this effect runs, so nothing has been cleared.
  const [phase, setPhase] = useState<Phase>("exchanging");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");

  useEffect(() => {
    if (failure) {
      setPhase("failed");
      setMessage(explainLinkFailure(failure));
      return;
    }
    if (!token) {
      setPhase("no-token");
      return;
    }
    let cancelled = false;

    (async () => {
      // THE EXCHANGE. This is the only thing that spends the token, and it is
      // a POST — which is what makes the link survive a mail scanner.
      const { data, error } = await supabase.auth.verifyOtp({
        token_hash: token.tokenHash,
        type: token.type,
      });
      if (cancelled) return;

      if (error) {
        setPhase("failed");
        // The server's own words, not a guess. A link opened twice and a link
        // three days old fail differently and the reader can act on neither
        // unless told which.
        setMessage(
          explainLinkFailure({ code: "otp_expired", description: error.message }),
        );
        return;
      }

      setEmail(data.user?.email ?? "");
      setPhase("choose");
      // STRIPPED ONLY NOW THAT IT IS SPENT. Until used, the token is a bearer
      // credential for this account and does not belong in browser history or
      // in anything that logs a referrer — but stripping it before the
      // exchange is precisely the bug that made the previous version of this
      // flow never work. Order first, tidiness second.
      window.history.replaceState(null, "", window.location.pathname);
    })();

    return () => {
      cancelled = true;
    };
    // The token is a module-load snapshot, so this runs exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === "exchanging") {
    return (
      <Shell>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Checking your invitation…
        </div>
      </Shell>
    );
  }

  if (phase === "choose") {
    return (
      <SetPasswordScreen
        {...(email ? { email } : {})}
        firstTime={token?.flow === "invite"}
        onDone={() => navigate({ to: "/" })}
      />
    );
  }

  // Both remaining phases are dead ends for the link, so both offer the two
  // things that actually help: ask for a fresh one, or sign in if they already
  // have a password. Offering neither is what the old sign-in form did.
  return (
    <Shell>
      <div className="mb-2 inline-flex items-center gap-1.5 rounded border border-warning/50 bg-warning/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-warning">
        <MailWarning className="size-3" />
        {phase === "failed" ? "Link not usable" : "Nothing to open"}
      </div>
      <h1 className="font-display text-lg font-semibold">
        {phase === "failed" ? "That invitation link has expired" : "Nothing to set up here"}
      </h1>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        {phase === "failed"
          ? message
          : "This page is where an invitation link lands. Open the link from your email, or sign in if you already have a password."}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button onClick={() => navigate({ to: "/forgot-password" })}>
          Email me a new link
        </Button>
        <Button variant="ghost" onClick={() => navigate({ to: "/" })}>
          Sign in instead
        </Button>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid-backdrop flex min-h-screen items-center justify-center bg-background px-4">
      <div className="console-panel w-full max-w-sm space-y-1 p-6">
        {/* BUILD_BRAND, not the organization's: nobody is signed in yet, so
            there is no organization to resolve one from. Same reasoning as
            the sign-in screen. */}
        {BUILD_BRAND.logoUrl && <BrandMark brand={BUILD_BRAND} size={10} className="mb-3" />}
        {children}
      </div>
    </div>
  );
}
