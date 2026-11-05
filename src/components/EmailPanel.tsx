// The invitation email panel — /admin, platform administrators only.
//
// WHY IT IS HERE AND NOT IN THE SUPABASE DASHBOARD. The copy used to be
// GoTrue's, which can interpolate the address, the link and the token and
// nothing else — so it could not name who did the inviting or which workshop
// they were invited to, and the best subject available was "Reset Your
// Password". Real test users reported that as phishing, correctly: an
// unsolicited password-reset mail is the commonest phishing pattern there is.
// Those two facts cannot be added from outside the sender, so the product
// writes the message itself and the words live where they can be edited by the
// person responsible for them.
//
// THREE THINGS THIS PANEL HAS TO DO, each from a defect:
//
//   * SAY WHETHER MAIL IS SWITCHED ON AT ALL. "A user never received the
//     invitation" was unanswerable while SMTP configuration was visible only
//     in deploy logs.
//   * SHOW WHAT ACTUALLY HAPPENED. The audit row recorded our intention to
//     email, not the mail server's answer — so a rejection, a deferral and a
//     success all looked identical.
//   * PREVIEW THROUGH THE REAL RENDERER. The branding panel's lesson: a
//     preview that computes its own answer is confidently wrong, and the one
//     thing a preview must never do is disagree with what goes out.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Loader2,
  Mail,
  MailWarning,
  RotateCcw,
  Send,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PanelHeading } from "@/components/workshop-ui";
import { cn } from "@/lib/utils";
import { adminApi, type EmailDelivery, type EmailTemplate, type MailStatus } from "@/lib/api";

const TITLES: Record<EmailTemplate["key"], { name: string; when: string }> = {
  participant_invite: {
    name: "Invitation",
    when: "Sent when somebody is invited to a workshop.",
  },
  password_reset: {
    name: "Password reset",
    when: "Sent when somebody asks to reset their password, or an admin issues a reset.",
  },
  password_set_confirmation: {
    name: "Confirmation",
    when: "Sent once somebody has chosen their password, to confirm they are in.",
  },
};

export function EmailPanel() {
  const queryClient = useQueryClient();
  const [key, setKey] = useState<EmailTemplate["key"]>("participant_invite");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState<{ subject: string; text: string } | null>(null);

  const templatesQuery = useQuery({
    queryKey: ["admin-email-templates"],
    queryFn: () => adminApi.emailTemplates(),
    retry: false,
  });

  const templates = templatesQuery.data?.templates ?? [];
  const mail = templatesQuery.data?.mail;
  const selected = templates.find((t) => t.key === key);

  // Load the stored copy into the form. Keyed on the template so switching
  // discards an unsaved edit rather than carrying the invitation's wording
  // into the confirmation's record — the same rule the branding panel follows.
  useEffect(() => {
    if (!selected) return;
    setSubject(selected.subject);
    setBody(selected.body);
    setDirty(false);
    setPreview(null);
  }, [selected?.key, selected?.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: () => adminApi.setEmailTemplate(key, { subject, body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-email-templates"] });
      setDirty(false);
      toast.success("Saved. The next invitation uses this wording.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const runPreview = useMutation({
    mutationFn: () => adminApi.previewEmailTemplate(key, { subject, body }),
    onSuccess: (r) => setPreview({ subject: r.subject, text: r.text }),
    onError: (e: Error) => toast.error(e.message),
  });

  const sendTest = useMutation({
    mutationFn: () => adminApi.testEmailTemplate(key),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["admin-email-deliveries"] });
      toast.success(`Sent to ${r.sent_to}. ${r.note}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (templatesQuery.isLoading) {
    return (
      <section className="console-panel" data-build="live">
        <PanelHeading build="live" title="Invitation emails" />
        <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading…
        </div>
      </section>
    );
  }
  if (templatesQuery.isError) return null;

  return (
    <section className="console-panel" data-build="live">
      <PanelHeading
        build="live"
        title="Invitation emails"
        hint="The wording, and what was actually sent"
      />

      <MailStatusRow mail={mail} />

      <div className="flex flex-wrap gap-1.5 border-b border-border px-4 py-2.5">
        {templates.map((t) => (
          <button
            key={t.key}
            onClick={() => setKey(t.key)}
            className={cn(
              "rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors",
              t.key === key
                ? "border-foreground/30 bg-foreground/10 text-foreground"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {TITLES[t.key]?.name ?? t.key}
          </button>
        ))}
      </div>

      {selected && (
        <div className="space-y-3 p-4">
          <p className="text-xs text-muted-foreground">{TITLES[selected.key]?.when}</p>

          <div className="space-y-1.5">
            <p className="label-caps">Subject</p>
            <Input
              id="email-subject"
              value={subject}
              onChange={(e) => {
                setSubject(e.target.value);
                setDirty(true);
              }}
            />
          </div>

          <div className="space-y-1.5">
            <p className="label-caps">Message</p>
            <Textarea
              id="email-body"
              rows={16}
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                setDirty(true);
              }}
              className="font-mono text-xs leading-relaxed"
            />
            {/* THE VOCABULARY, shown rather than documented elsewhere. A save
                using anything outside it is refused by the server, which is
                the right place for the refusal — the alternative is a typo
                rendering as nothing at all, first noticed by the invitee
                reading a sentence with a hole in it. */}
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Placeholders you can use:{" "}
              {selected.allowed.map((p, i) => (
                <span key={p}>
                  {i > 0 && ", "}
                  <button
                    type="button"
                    onClick={() => {
                      setBody((b) => `${b}{{${p}}}`);
                      setDirty(true);
                    }}
                    className="font-mono text-foreground underline decoration-dotted"
                    title={`Append {{${p}}} to the message`}
                  >
                    {`{{${p}}}`}
                  </button>
                </span>
              ))}
            </p>
            {/* Plain text on purpose. An administrator editing marketing-grade
                HTML in a textarea produces broken HTML, and an invitation is a
                short personal message, not a newsletter. The HTML part is
                derived from this one source, so the two cannot disagree. */}
            <p className="text-[11px] text-muted-foreground">
              Write it as plain text. Links become clickable and indented lines stay aligned.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
              {save.isPending && <Loader2 className="size-3.5 animate-spin" />}
              Save wording
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => runPreview.mutate()}
              disabled={runPreview.isPending}
            >
              {runPreview.isPending && <Loader2 className="size-3.5 animate-spin" />}
              Preview
            </Button>
            {/* THE CALLER'S OWN ADDRESS, and no other. An admin panel that
                mails arbitrary addresses on request is an open relay behind a
                login page, and the reputation damage lands on the sending
                domain that every real invitation then depends on. */}
            <Button
              size="sm"
              variant="secondary"
              onClick={() => sendTest.mutate()}
              disabled={sendTest.isPending || !mail?.configured}
              title={
                mail?.configured
                  ? "Sends this message to your own address"
                  : "No SMTP server is configured"
              }
            >
              {sendTest.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Send className="size-3.5" />
              )}
              Send me a test
            </Button>
            {dirty && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSubject(selected.subject);
                  setBody(selected.body);
                  setDirty(false);
                }}
              >
                <RotateCcw className="size-3.5" />
                Discard changes
              </Button>
            )}
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">
              {selected.updated_by
                ? `edited by ${selected.updated_by}`
                : "never edited"}
            </span>
          </div>

          {preview && (
            <div className="rounded-md border border-border bg-elevated p-3">
              <p className="label-caps">Preview</p>
              <p className="mt-1.5 text-xs font-medium">{preview.subject}</p>
              <pre className="mt-2 whitespace-pre-wrap font-sans text-xs leading-relaxed text-muted-foreground">
                {preview.text}
              </pre>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Rendered with example values, by the same code that sends it.
              </p>
            </div>
          )}
        </div>
      )}

      <DeliveryLog />
    </section>
  );
}

/**
 * Whether mail is switched on, stated plainly.
 *
 * Without this the first question in every "they never got it" report —
 * is sending even configured? — could only be answered by reading deploy
 * logs, and the honest answer for this deployment was "no".
 */
function MailStatusRow({ mail }: { mail: MailStatus | undefined }) {
  if (!mail) return null;
  if (!mail.configured) {
    return (
      <div className="flex items-start gap-2 border-b border-border bg-warning/10 px-4 py-2.5">
        <MailWarning className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <div className="text-[11px] leading-relaxed">
          <p className="font-medium">No mail server is configured, so nothing can be emailed.</p>
          <p className="text-muted-foreground">
            Invitations fall back to Supabase's built-in template — the one titled "Reset Your
            Password", which cannot name the inviter or the workshop — and then to a link for you
            to pass on by hand. Set{" "}
            <span className="font-mono">SMTP_HOST</span>,{" "}
            <span className="font-mono">SMTP_USERNAME</span>,{" "}
            <span className="font-mono">SMTP_PASSWORD</span> and{" "}
            <span className="font-mono">MAIL_FROM</span> on the server.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2.5 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5 text-foreground">
        <Mail className="size-3.5" />
        Sending as <span className="font-mono">{mail.from}</span>
      </span>
      <span className="font-mono">
        {mail.host}:{mail.port} · {mail.encryption}
      </span>
    </div>
  );
}

/**
 * What was attempted and what the mail server said.
 *
 * "Sent" means the server ACCEPTED it, which is the strongest claim any sender
 * can make — it is not proof of inbox placement, and this says so rather than
 * implying delivery. A sender that cannot distinguish the two is how "it was
 * emailed successfully" and "nobody received it" come to be both true.
 */
function DeliveryLog() {
  const q = useQuery({
    queryKey: ["admin-email-deliveries"],
    queryFn: () => adminApi.emailDeliveries(),
    retry: false,
  });
  const rows = q.data ?? [];

  return (
    <div className="border-t border-border">
      <div className="flex items-baseline justify-between gap-2 px-4 py-2.5">
        <p className="label-caps">Recent deliveries</p>
        <span className="font-mono text-[10px] text-muted-foreground">
          {rows.length === 0 ? "nothing sent yet" : `${rows.length} most recent`}
        </span>
      </div>
      {rows.length > 0 && (
        <ul className="divide-y divide-border">
          {rows.slice(0, 25).map((d) => (
            <DeliveryRow key={d.id} delivery={d} />
          ))}
        </ul>
      )}
      <p className="px-4 pb-3 text-[11px] leading-snug text-muted-foreground">
        "Sent" means the mail server accepted the message. It is not proof that it reached an
        inbox — a message can still be filtered or silently discarded after that, which is why
        a failure here is worth acting on and a success is worth confirming with the recipient.
      </p>
    </div>
  );
}

function DeliveryRow({ delivery: d }: { delivery: EmailDelivery }) {
  const icon =
    d.status === "sent" ? (
      <CheckCircle2 className="size-3.5 shrink-0 text-success" />
    ) : d.status === "failed" ? (
      <XCircle className="size-3.5 shrink-0 text-destructive" />
    ) : (
      <MailWarning className="size-3.5 shrink-0 text-muted-foreground" />
    );

  return (
    <li className="flex items-start gap-2 px-4 py-2 text-xs">
      <span className="mt-0.5">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="font-medium">{d.to_email}</span>
        <span className="text-muted-foreground"> — {d.subject}</span>
        {d.workshop_name && (
          <span className="text-muted-foreground"> · {d.workshop_name}</span>
        )}
        {/* THE SERVER'S OWN WORDS, quoted and not paraphrased. The first
            version of the old failure explainer guessed a cause, named the
            wrong one with complete confidence, and would have sent somebody to
            reconfigure working mail. */}
        {d.error && (
          <span className="mt-0.5 block leading-snug text-destructive">{d.error}</span>
        )}
        {d.route === "supabase" && (
          <span className="mt-0.5 block leading-snug text-muted-foreground">
            Sent with Supabase's built-in template, which cannot name the inviter or the
            workshop.
          </span>
        )}
      </span>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
        {new Date(d.created_at).toLocaleString()}
      </span>
    </li>
  );
}
