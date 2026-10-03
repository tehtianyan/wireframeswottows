import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Radio, Search, Trash2, UserPlus, WifiOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PanelHeading } from "@/components/workshop-ui";
import { cn } from "@/lib/utils";
import { OneTimeLink } from "@/components/OneTimeLink";
import { useCurrentPerson } from "@/lib/useCurrentPerson";
import { useWorkshopPresence } from "@/lib/useWorkshopPresence";
import {
  assignableRoles,
  initials,
  inviteParticipant,
  participantsQueryOptions,
  removeParticipant,
  roleLabels,
  updateParticipantRole,
  type Participant,
  type ParticipantRole,
} from "@/lib/participants";
import type { InviteResult } from "@/lib/api";

// The Participants roster.
//
// THREE THINGS THE OLD VERSION CONFLATED, now kept apart, because each answers
// a different question a facilitator actually asks:
//
//   On the roster  — we have given this person access.
//   Signed in      — they have opened the workshop at least once (joined_at,
//                    now stamped SERVER-side on first access; it used to be
//                    written by the client and by the seed, so it was set for
//                    everybody and told you nothing).
//   Online now     — they are here at this moment, from a Realtime presence
//                    channel.
//
// The green dot means ONLINE NOW. It previously sat beside a "joined" status
// that was true for everyone permanently, so the panel reported the whole room
// present at all times. An earlier fix had deliberately relabelled the dot
// "joined" and said why — the product had no realtime then. It does now.

const roleBadge: Record<ParticipantRole, string> = {
  facilitator: "border-primary/50 bg-primary/10 text-primary",
  analyst: "border-info/50 bg-info/10 text-info",
  executive_viewer: "border-opportunity/50 bg-opportunity/10 text-opportunity",
  participant: "border-border bg-elevated text-muted-foreground",
  observer: "border-border bg-elevated text-muted-foreground",
};

export function ParticipantsPanel({
  workshopId,
  canManage,
  readOnly = false,
}: {
  workshopId: string;
  canManage: boolean;
  /** True when the workshop is archived: the roster is shown, not edited. */
  readOnly?: boolean;
}) {
  const queryClient = useQueryClient();
  const me = useCurrentPerson();
  const { status: presenceStatus, onlineIds } = useWorkshopPresence(workshopId, me);

  const { data: people = [], isLoading, isError } = useQuery(participantsQueryOptions(workshopId));

  const [query, setQuery] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", role: "participant" as ParticipantRole });
  const [lastInvite, setLastInvite] = useState<InviteResult | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["workshop-participants", workshopId] });

  const invite = useMutation({
    mutationFn: () =>
      inviteParticipant(workshopId, {
        email: form.email.trim(),
        ...(form.name.trim() ? { name: form.name.trim() } : {}),
        role: form.role,
      }),
    onSuccess: (res) => {
      refresh();
      setLastInvite(res);
      setForm({ name: "", email: "", role: "participant" });
      toast.success(
        res.new_account
          ? `Account created for ${res.email}. Send them the link below.`
          : `${res.email} already had an account and now has access. Send them the link below.`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const setRole = useMutation({
    mutationFn: (v: { userId: string; role: ParticipantRole }) =>
      updateParticipantRole(workshopId, v.userId, v.role),
    onSuccess: () => {
      refresh();
      toast.success("Role updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const revoke = useMutation({
    mutationFn: (userId: string) => removeParticipant(workshopId, userId),
    onSuccess: () => {
      refresh();
      setConfirmRemove(null);
      toast.success("Access revoked. Their contributions stay in the workshop.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return people;
    return people.filter(
      (p) => p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q),
    );
  }, [people, query]);

  const online = people.filter((p) => onlineIds.has(p.user_id)).length;
  const signedIn = people.filter((p) => p.has_signed_in).length;
  const lockedOut = people.filter((p) => !p.in_workspace);

  const editable = canManage && !readOnly;

  return (
    <section className="console-panel" data-build="live">
      <PanelHeading
        build="live"
        title="Participants"
        hint={`${people.length} on the roster · ${signedIn} have signed in`}
        action={
          editable ? (
            <Button variant="secondary" size="sm" onClick={() => setInviteOpen((v) => !v)}>
              <UserPlus className="size-3.5" />
              Invite
            </Button>
          ) : null
        }
      />

      {/* Live status, stated honestly. Saying nobody is online when the socket
          is down would be a different lie from the one this replaces. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-elevated/40 px-3.5 py-2">
        {presenceStatus === "live" ? (
          <>
            <Radio className="size-3.5 text-success" />
            <span className="text-xs text-muted-foreground">
              {online === 0
                ? "Nobody else is in the workshop right now"
                : `${online} in the workshop right now`}
            </span>
          </>
        ) : presenceStatus === "connecting" ? (
          <>
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Checking who is here…</span>
          </>
        ) : (
          <>
            <WifiOff className="size-3.5 text-warning" />
            <span className="text-xs text-muted-foreground">
              Live status unavailable — the roster below is still accurate
            </span>
          </>
        )}
      </div>

      {readOnly && (
        <p className="border-b border-border px-3.5 py-2 text-xs text-muted-foreground">
          This workshop is archived, so its roster cannot be changed. Un-archive it to manage
          participants.
        </p>
      )}

      {lockedOut.length > 0 && (
        <div className="flex items-start gap-2 border-b border-warning/40 bg-warning/5 px-3.5 py-2.5">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <p className="text-xs leading-snug text-muted-foreground">
            <span className="text-foreground">
              {lockedOut.length} {lockedOut.length === 1 ? "person has" : "people have"} no
              workspace access
            </span>{" "}
            and will be refused everywhere despite being on this roster
            {lockedOut.length <= 3 && `: ${lockedOut.map((p) => p.email).join(", ")}`}. Re-inviting
            them repairs it.
          </p>
        </div>
      )}

      {inviteOpen && editable && (
        <div className="space-y-2 border-b border-border bg-elevated/40 p-3.5">
          <p className="label-caps">Invite someone</p>
          <Input
            type="email"
            placeholder="Email address"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            autoFocus
          />
          <Input
            placeholder="Name (optional)"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
          <Select
            value={form.role}
            onValueChange={(v) => setForm((f) => ({ ...f, role: v as ParticipantRole }))}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {assignableRoles.map((r) => (
                <SelectItem key={r} value={r}>
                  {roleLabels[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] leading-snug text-muted-foreground">
            Creates an account if they do not have one and gives them access to this workshop. No
            email is sent — you get a one-time link to pass on, so you always know the invite
            exists.
          </p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setInviteOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!form.email.trim() || invite.isPending}
              onClick={() => invite.mutate()}
            >
              {invite.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Invite
            </Button>
          </div>
        </div>
      )}

      {lastInvite && (
        <OneTimeLink
          email={lastInvite.email}
          {...(lastInvite.invite_link ? { link: lastInvite.invite_link } : {})}
          {...(lastInvite.link_type ? { kind: lastInvite.link_type } : {})}
          {...(lastInvite.link_error ? { error: lastInvite.link_error } : {})}
          onDismiss={() => setLastInvite(null)}
        />
      )}

      <div className="border-b border-border p-3.5">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search by name or email"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="divide-y divide-border">
        {isLoading && (
          <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading the roster…
          </div>
        )}
        {isError && <p className="p-4 text-xs text-destructive">Could not load the roster.</p>}
        {!isLoading && visible.length === 0 && (
          <p className="p-4 text-xs text-muted-foreground">
            {query ? "Nobody matches that." : "Nobody has been invited yet."}
          </p>
        )}

        {visible.map((p) => (
          <ParticipantRow
            key={p.user_id}
            person={p}
            isOnline={onlineIds.has(p.user_id)}
            presenceKnown={presenceStatus === "live"}
            isMe={me?.user_id === p.user_id}
            editable={editable}
            busy={
              (setRole.isPending && setRole.variables?.userId === p.user_id) ||
              (revoke.isPending && revoke.variables === p.user_id)
            }
            confirming={confirmRemove === p.user_id}
            onRole={(role) => setRole.mutate({ userId: p.user_id, role })}
            onAskRemove={() => setConfirmRemove(p.user_id)}
            onCancelRemove={() => setConfirmRemove(null)}
            onConfirmRemove={() => revoke.mutate(p.user_id)}
          />
        ))}
      </div>
    </section>
  );
}

function ParticipantRow({
  person,
  isOnline,
  presenceKnown,
  isMe,
  editable,
  busy,
  confirming,
  onRole,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
}: {
  person: Participant;
  isOnline: boolean;
  /** False when the socket is down, so the dot is omitted rather than shown grey. */
  presenceKnown: boolean;
  isMe: boolean;
  editable: boolean;
  busy: boolean;
  confirming: boolean;
  onRole: (role: ParticipantRole) => void;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
}) {
  return (
    <div className={cn("px-3.5 py-3", busy && "opacity-60")}>
      <div className="flex items-start gap-3">
        <div className="relative shrink-0">
          <span className="grid size-8 place-items-center rounded-full border border-border bg-elevated font-mono text-[10px] font-semibold text-muted-foreground">
            {initials(person.name)}
          </span>
          {/* ONLINE NOW — not "joined", and not shown at all when we cannot
              know, because an absent dot is honest and a grey one is a guess. */}
          {presenceKnown && isOnline && (
            <span
              className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background bg-success"
              title="In the workshop now"
              aria-label="In the workshop now"
            />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="truncate text-sm font-medium">{person.name}</p>
            {isMe && (
              <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                you
              </span>
            )}
            <span
              className={cn(
                "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
                roleBadge[person.role],
              )}
            >
              {roleLabels[person.role]}
            </span>
          </div>
          <p className="truncate text-xs text-muted-foreground">{person.email}</p>

          <p className="mt-1 text-[11px] text-muted-foreground">
            {presenceKnown && isOnline ? (
              <span className="text-success">In the workshop now</span>
            ) : person.has_signed_in ? (
              `Last joined ${new Date(person.joined_at!).toLocaleDateString()}`
            ) : (
              <span className="text-warning">Has not signed in yet</span>
            )}
            {" · "}
            {person.factors_created} contributed
            {person.weights_set > 0 && ` · ${person.weights_set} rated`}
          </p>
        </div>

        {editable && !confirming && (
          <div className="flex shrink-0 items-center gap-1">
            <Select value={person.role} onValueChange={(v) => onRole(v as ParticipantRole)}>
              <SelectTrigger className="h-7 w-[7.5rem] text-[11px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {assignableRoles.map((r) => (
                  <SelectItem key={r} value={r}>
                    {roleLabels[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="icon"
              variant="ghost"
              className="size-7 text-muted-foreground hover:text-destructive"
              onClick={onAskRemove}
              disabled={busy}
              aria-label={`Revoke access for ${person.name}`}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        )}
      </div>

      {confirming && (
        <div className="mt-2 rounded-sm border border-destructive/40 bg-destructive/5 p-2.5">
          <p className="text-xs leading-snug text-muted-foreground">
            Revoke <span className="text-foreground">{person.name}</span>’s access to this
            workshop? Everything they contributed stays — removing it would change the
            prioritization totals and rewrite what the workshop recorded.
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onCancelRemove}>
              Cancel
            </Button>
            <Button size="sm" variant="destructive" onClick={onConfirmRemove} disabled={busy}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Revoke access
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
