import { useState } from "react";
import { Check, Copy, Mail } from "lucide-react";
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
  warning,
  emailed,
  deliveryError,
  onDismiss,
}: {
  email: string;
  link?: string;
  kind?: "invite" | "recovery";
  /** Set when access was granted but no link could be minted. */
  error?: string;
  /**
   * The link was MAILED to them, so there is no link to show. Not an
   * oversight: GoTrue keeps one token per user and clears the old one when it
   * writes a new one, so minting a link to display here would invalidate the
   * one already in their inbox.
   */
  emailed?: boolean;
  /**
   * An email was asked for, could not be sent, and a link was produced
   * instead. Shown ABOVE the link, because the failure mode is somebody
   * assuming the mail went and telling the invitee nothing.
   */
  deliveryError?: string;
  /**
   * Set when the link exists but points somewhere unintended, because Supabase
   * overruled the destination. Shown ABOVE the link rather than below it: the
   * whole failure mode is somebody copying a link that looks fine.
   */
  warning?: string;
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
  // Mailed: confirm it and stop. Nothing to copy, nothing to leak.
  if (emailed && !link) {
    return (
      <div className="space-y-1 border-b border-border bg-elevated/40 px-3.5 py-2.5">
        <p className="flex items-center gap-1.5 text-xs">
          <Mail className="size-3.5 shrink-0 text-success" />
          <span>
            {kind === "recovery" ? "Sign-in link" : "Invitation"} emailed to{" "}
            <span className="font-medium">{email}</span>
          </span>
        </p>
        <p className="text-[11px] leading-snug text-muted-foreground">
          It works once and then expires. If it does not arrive, check the spam folder before
          sending another — a new one invalidates the first.
        </p>
        <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={onDismiss}>
          Done
        </Button>
      </div>
    );
  }

  if (!link) return null;

  return (
    <div className="space-y-1.5 border-b border-border bg-elevated/40 px-3.5 py-2.5">
      {deliveryError && (
        <p className="rounded-sm border border-warning/50 bg-warning/10 p-2 text-[11px] leading-snug text-foreground">
          <span className="font-semibold">This was NOT emailed.</span> {deliveryError}
        </p>
      )}
      {warning && (
        <p className="rounded-sm border border-warning/50 bg-warning/10 p-2 text-[11px] leading-snug text-foreground">
          <span className="font-semibold">Do not send this yet.</span> {warning}
        </p>
      )}
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
