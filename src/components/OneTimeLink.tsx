import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

// A one-time sign-in or password-reset link, shown once with a copy button.
//
// Nothing is emailed. Supabase's built-in mailer is heavily rate-limited and,
// on newer projects, only delivers to the project members' own addresses — so
// asking it to mail a client's domain can fail silently, which is the worst
// possible outcome for an invitation: you believe somebody was invited and they
// never hear from you. A minted link always exists, and whoever invited them
// can send it by whatever channel they already use.
//
// It is a BEARER CREDENTIAL for that account until it is used, which is why the
// server never writes it to the audit trail and why the copy says so.

export function OneTimeLink({
  email,
  link,
  kind,
  error,
  onDismiss,
}: {
  email: string;
  link?: string;
  kind?: "invite" | "recovery";
  /** Set when access was granted but no link could be minted. */
  error?: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  if (error) {
    return (
      <div className="border-b border-warning/40 bg-warning/5 px-3.5 py-2.5">
        <p className="text-xs leading-snug text-muted-foreground">{error}</p>
        <Button
          size="sm"
          variant="ghost"
          className="mt-1 h-6 px-1.5 text-[11px]"
          onClick={onDismiss}
        >
          Dismiss
        </Button>
      </div>
    );
  }
  if (!link) return null;

  return (
    <div className="space-y-1.5 border-b border-border bg-elevated/40 px-3.5 py-2.5">
      <p className="label-caps">
        {kind === "recovery" ? "Sign-in link" : "Invite link"} for {email}
      </p>
      <p className="break-all rounded-sm border border-border bg-background p-2 font-mono text-[10px] leading-snug">
        {link}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] leading-snug text-muted-foreground">
          {kind === "recovery"
            ? "They set a new password when they open it."
            : "They set their own password when they open it."}{" "}
          Usable once. Treat it like a password — it is not recorded anywhere else.
        </p>
        <div className="flex shrink-0 gap-1">
          <Button
            size="sm"
            variant="secondary"
            className="h-7 text-[11px]"
            onClick={() => {
              void navigator.clipboard.writeText(link).then(
                () => {
                  setCopied(true);
                  toast.success("Link copied");
                },
                // Clipboard access is refused in some contexts, so say what to
                // do instead of appearing to have copied it.
                () => toast.error("Could not copy — select the link and copy it manually."),
              );
            }}
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={onDismiss}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}
