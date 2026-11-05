import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Loader2, MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BrandMark } from "@/components/BrandMark";
import { BUILD_BRAND } from "@/lib/brand";
import { authApi } from "@/lib/api";

// "I have forgotten my password."
//
// There was no way back in. Somebody who forgot their password had to find an
// administrator, who had to mint a link and pass it on by hand — and until
// then the sign-in page simply asked again for the thing they did not know.
// That is the single commonest reason a real person cannot use an application,
// and it had no screen at all.
//
// Renders OUTSIDE AuthGate (see __root.tsx), because by definition the person
// cannot sign in.

export const Route = createFileRoute("/forgot-password")({
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [answer, setAnswer] = useState("");
  const [problem, setProblem] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setProblem("");
    try {
      const res = await authApi.forgotPassword(email.trim());
      // THE SERVER'S SENTENCE, NOT OUR OWN. The answer is identical whether or
      // not that address has an account — that uniformity is what stops this
      // page being used to find out who a client's staff are, and the one
      // place it could leak is here. Composing a message on this side would
      // re-introduce exactly that branch.
      setAnswer(res.message);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="grid-backdrop flex min-h-screen items-center justify-center bg-background px-4">
      <div className="console-panel w-full max-w-sm p-6">
        {BUILD_BRAND.logoUrl && <BrandMark brand={BUILD_BRAND} size={10} className="mb-3" />}

        {answer ? (
          <div className="space-y-4">
            <div className="inline-flex items-center gap-1.5 rounded border border-success/50 bg-success/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-success">
              <MailCheck className="size-3" />
              Check your email
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">{answer}</p>
            {/* Said here as well as in the email, because a corporate scanner
                opening the link first is the commonest reason a perfectly
                sent link does not work — and somebody who hits that twice
                should know it is not their mistake. */}
            <p className="text-[11px] leading-snug text-muted-foreground">
              The link works once. If your email system shows a security warning or opens links
              to check them, it may use the link up before you do — ask for another and open it
              as soon as it arrives.
            </p>
            <Link to="/" className="block text-xs text-muted-foreground underline hover:text-foreground">
              Back to sign in
            </Link>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={submit}>
            <div>
              <h1 className="font-display text-lg font-semibold">Reset your password</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Enter the address you were invited with and we will email you a link to choose a
                new password.
              </p>
            </div>
            <div className="space-y-1.5">
              <p className="label-caps">Email</p>
              <Input
                id="forgot-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                autoComplete="email"
              />
            </div>
            {problem && <p className="text-[11px] text-destructive">{problem}</p>}
            <Button type="submit" className="w-full" disabled={sending || !email.trim()}>
              {sending && <Loader2 className="size-3.5 animate-spin" />}
              Email me a link
            </Button>
            <Link to="/" className="block text-center text-xs text-muted-foreground underline hover:text-foreground">
              Back to sign in
            </Link>
          </form>
        )}
      </div>
    </div>
  );
}
