import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Mail, MessageSquare, Search, Trash2, UserPlus, Vote } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { PanelHeading } from "@/components/workshop-ui";
import { cn } from "@/lib/utils";
import { useCan, useWorkshop } from "@/lib/workshop-store";
import {
  activateParticipant,
  initials,
  inviteParticipant,
  participantsQueryOptions,
  removeParticipant,
  roleLabels,
  updateParticipantRole,
  type ParticipantRecord,
  type ParticipantRole,
} from "@/lib/participants";

const presenceDot: Record<string, string> = {
  online: "bg-success",
  idle: "bg-warning",
  offline: "bg-muted-foreground/40",
};

const roleBadge: Record<ParticipantRole, string> = {
  facilitator: "border-primary/50 bg-primary/10 text-primary",
  analyst: "border-info/50 bg-info/10 text-info",
  executive: "border-opportunity/50 bg-opportunity/10 text-opportunity",
  participant: "border-border bg-elevated text-muted-foreground",
};

const roleOptions: ParticipantRole[] = ["participant", "analyst", "facilitator", "executive"];

export function ParticipantsPanel() {
  const { voteAllocation } = useWorkshop();
  const canManage = useCan("invite");
  const queryClient = useQueryClient();

  const { data: people = [], isLoading, isError } = useQuery(participantsQueryOptions);

  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<ParticipantRole | "all">("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", role: "participant" as ParticipantRole });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["workshop-participants"] });

  const invite = useMutation({
    mutationFn: inviteParticipant,
    onSuccess: async () => {
      await refresh();
      toast.success("Invitation sent");
      setForm({ name: "", email: "", role: "participant" });
      setInviteOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const changeRole = useMutation({
    mutationFn: (v: { id: string; role: ParticipantRole }) => updateParticipantRole(v.id, v.role),
    onSuccess: async (_d, v) => {
      await refresh();
      toast.success(`Role updated to ${roleLabels[v.role]}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const activate = useMutation({
    mutationFn: activateParticipant,
    onSuccess: async () => {
      await refresh();
      toast.success("Participant marked active");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: removeParticipant,
    onSuccess: async () => {
      await refresh();
      setOpenId(null);
      toast.success("Participant removed from the workshop");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const stats = useMemo(() => {
    const online = people.filter((p) => p.presence === "online").length;
    const idle = people.filter((p) => p.presence === "idle").length;
    const invited = people.filter((p) => p.status === "invited").length;
    const engaged = people.filter((p) => p.votes_used > 0).length;
    return { online, idle, invited, engaged, offline: people.length - online - idle };
  }, [people]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return people.filter(
      (p) =>
        (roleFilter === "all" || p.role === roleFilter) &&
        (!q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)),
    );
  }, [people, query, roleFilter]);

  const selected = people.find((p) => p.id === openId) ?? null;

  function guard() {
    if (canManage) return true;
    toast.error("Only a facilitator can manage participants");
    return false;
  }

  return (
    <section className="console-panel" data-build="live">
      <PanelHeading
        build="live"
        title="Participants"
        hint={`${people.length} on the roster · ${stats.online} online`}
        action={
          canManage ? (
            <Button variant="secondary" size="sm" onClick={() => setInviteOpen((v) => !v)}>
              <UserPlus className="size-3.5" /> Invite
            </Button>
          ) : undefined
        }
      />

      {/* presence distribution */}
      <div className="border-b border-border px-4 py-3">
        <div className="flex h-1.5 overflow-hidden rounded-full bg-elevated">
          {(["online", "idle", "offline"] as const).map((k) => {
            const count = k === "online" ? stats.online : k === "idle" ? stats.idle : stats.offline;
            const pct = people.length ? (count / people.length) * 100 : 0;
            return <span key={k} className={cn("h-full", presenceDot[k])} style={{ width: `${pct}%` }} />;
          })}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          <span>{stats.online} online</span>
          <span>{stats.idle} idle</span>
          <span>{stats.offline} offline</span>
          <span>{stats.invited} pending invite</span>
          <span>{stats.engaged} voted</span>
        </div>
      </div>

      {inviteOpen && canManage && (
        <div className="space-y-2 border-b border-border bg-elevated/50 p-4">
          <Input
            placeholder="Full name"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
          <Input
            placeholder="name@company.com"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
          />
          <div className="flex gap-2">
            <Select
              value={form.role}
              onValueChange={(v) => setForm((f) => ({ ...f, role: v as ParticipantRole }))}
            >
              <SelectTrigger className="flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roleOptions.map((r) => (
                  <SelectItem key={r} value={r}>
                    {roleLabels[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              disabled={invite.isPending}
              onClick={() => {
                if (!guard()) return;
                if (!form.name.trim() || !/.+@.+\..+/.test(form.email)) {
                  toast.warning("Add a name and a valid email address");
                  return;
                }
                invite.mutate({ name: form.name.trim(), email: form.email.trim(), role: form.role });
              }}
            >
              {invite.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Mail className="size-3.5" />}
              Send invite
            </Button>
          </div>
        </div>
      )}

      {/* search + role filter */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <div className="relative min-w-[160px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 pl-8 text-xs"
            placeholder="Search participants"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="flex gap-1">
          {(["all", ...roleOptions] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRoleFilter(r as ParticipantRole | "all")}
              className={cn(
                "rounded-full px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors",
                roleFilter === r
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {r === "all" ? "All" : roleLabels[r as ParticipantRole]}
            </button>
          ))}
        </div>
      </div>

      <div className="max-h-80 divide-y divide-border overflow-y-auto">
        {isLoading && (
          <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading roster…
          </div>
        )}
        {isError && <p className="p-4 text-xs text-destructive">Could not load the participant roster.</p>}
        {!isLoading && !isError && visible.length === 0 && (
          <p className="p-4 text-xs text-muted-foreground">No participants match this filter.</p>
        )}
        {visible.map((p) => (
          <button
            key={p.id}
            onClick={() => setOpenId(p.id)}
            className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-elevated/60"
          >
            <span className="relative grid size-8 shrink-0 place-items-center rounded-full bg-elevated text-[10px] font-semibold">
              {initials(p.name)}
              <span
                className={cn(
                  "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-card",
                  presenceDot[p.presence],
                )}
              />
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 truncate text-xs font-medium">
                {p.name}
                {p.status === "invited" && (
                  <span className="rounded-full bg-warning/15 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-warning">
                    Invited
                  </span>
                )}
              </p>
              <p className="truncate text-[11px] text-muted-foreground">{p.email}</p>
            </div>
            <div className="hidden w-24 shrink-0 sm:block">
              <Progress value={(p.votes_used / voteAllocation) * 100} className="h-1" />
              <p className="mt-1 font-mono text-[9px] text-muted-foreground">
                {p.votes_used}/{voteAllocation} votes
              </p>
            </div>
            <span
              className={cn(
                "shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider",
                roleBadge[p.role],
              )}
            >
              {p.role}
            </span>
          </button>
        ))}
      </div>

      <Sheet open={!!selected} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2.5">
                  <span className="grid size-9 place-items-center rounded-full bg-elevated text-xs font-semibold">
                    {initials(selected.name)}
                  </span>
                  {selected.name}
                </SheetTitle>
                <SheetDescription>
                  {selected.email} · joined {selected.joined_at} · last active {selected.last_active}
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-4 px-4 pb-6">
                <div className="grid grid-cols-3 gap-px overflow-hidden rounded-md bg-border">
                  {[
                    { label: "Votes used", value: `${selected.votes_used}/${voteAllocation}`, icon: Vote },
                    { label: "Artifacts", value: selected.artifacts_count, icon: UserPlus },
                    { label: "Comments", value: selected.comments_count, icon: MessageSquare },
                  ].map((s) => (
                    <div key={s.label} className="bg-card p-3">
                      <s.icon className="size-3.5 text-muted-foreground" />
                      <p className="mt-1 font-display text-lg font-semibold">{s.value}</p>
                      <p className="text-[11px] text-muted-foreground">{s.label}</p>
                    </div>
                  ))}
                </div>

                <div>
                  <p className="label-caps">Contribution</p>
                  <Progress
                    className="mt-2 h-1.5"
                    value={(selected.votes_used / voteAllocation) * 100}
                  />
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {selected.votes_used === 0
                      ? "Has not allocated any votes yet."
                      : `Allocated ${Math.round((selected.votes_used / voteAllocation) * 100)}% of the personal vote budget.`}
                  </p>
                </div>

                <div>
                  <p className="label-caps">Presence</p>
                  <p className="mt-1.5 flex items-center gap-2 text-xs capitalize">
                    <span className={cn("size-2 rounded-full", presenceDot[selected.presence])} />
                    {selected.presence} · status {selected.status}
                  </p>
                </div>

                <div className="space-y-2 rounded-md border border-border p-3">
                  <p className="label-caps">Manage</p>
                  <Select
                    value={selected.role}
                    onValueChange={(v) => {
                      if (!guard()) return;
                      changeRole.mutate({ id: selected.id, role: v as ParticipantRole });
                    }}
                    disabled={!canManage}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {roleOptions.map((r) => (
                        <SelectItem key={r} value={r}>
                          {roleLabels[r]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex flex-wrap gap-2">
                    {selected.status === "invited" && (
                      <>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => guard() && toast.success(`Invitation resent to ${selected.email}`)}
                        >
                          <Mail className="size-3.5" /> Resend invite
                        </Button>
                        <Button
                          size="sm"
                          disabled={activate.isPending}
                          onClick={() => guard() && activate.mutate(selected.id)}
                        >
                          Mark active
                        </Button>
                      </>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      disabled={remove.isPending}
                      onClick={() => guard() && remove.mutate(selected.id)}
                    >
                      <Trash2 className="size-3.5" /> Remove
                    </Button>
                  </div>
                  {!canManage && (
                    <p className="text-[11px] text-muted-foreground">
                      Switch to the facilitator role to manage the roster.
                    </p>
                  )}
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </section>
  );
}
