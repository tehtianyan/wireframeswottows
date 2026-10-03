import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, ChevronDown, Loader2, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PanelHeading } from "@/components/workshop-ui";
import { cn } from "@/lib/utils";
import { adminApi, participantsApi, type AdminWorkshop, type Participant } from "@/lib/api";
import { roleLabels, type ParticipantRole } from "@/lib/participants";

// Every workshop on the platform, for an administrator to service.
//
// WHY AN ADMIN NEEDS THIS AT ALL. The workshop-scoped participant routes
// require membership, so a facilitator can manage their own workshop — but a
// workshop whose facilitator has left the organisation had nobody who could fix
// it, and the way out was to add yourself as a member, which is the problem
// rather than the fix. These routes are gated on profiles.global_role instead.
//
// Deliberately NOT scoped to the caller's memberships, which is the point of an
// admin screen and exactly why the gate is a platform role.

export function AdminWorkshops() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);

  const workshopsQuery = useQuery({
    queryKey: ["admin-workshops"],
    queryFn: () => adminApi.workshops(),
    retry: false,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["admin-workshops"] });
    queryClient.invalidateQueries({ queryKey: ["workshops"] });
  };

  const archive = useMutation({
    mutationFn: (id: string) => participantsApi.archive(id),
    onSuccess: () => {
      invalidate();
      toast.success("Workshop archived — read-only until un-archived.");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const unarchive = useMutation({
    mutationFn: (id: string) => participantsApi.unarchive(id),
    onSuccess: (r) => {
      invalidate();
      toast.success(`Un-archived — back to ${r.status}.`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const workshops = workshopsQuery.data ?? [];
  const archived = workshops.filter((w) => w.status === "archived").length;

  return (
    <section className="console-panel" data-build="live">
      <PanelHeading
        build="live"
        title="Workshops"
        hint={`${workshops.length} total · ${archived} archived`}
      />

      {workshopsQuery.isLoading && (
        <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading workshops…
        </div>
      )}
      {workshopsQuery.isError && (
        <p className="p-4 text-xs text-destructive">Could not load workshops.</p>
      )}

      <div className="divide-y divide-border">
        {workshops.map((w) => (
          <div key={w.id}>
            <div className="flex flex-wrap items-start justify-between gap-2 px-4 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="text-sm font-medium">{w.name}</p>
                  <StatusPill status={w.status} />
                  {w.facilitators === 0 && (
                    // The case this screen exists for: nobody can manage it.
                    <span className="rounded border border-destructive/40 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-destructive">
                      no facilitator
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {w.workspace_name} · {w.methodology} · {w.members}{" "}
                  {w.members === 1 ? "member" : "members"}
                  {w.archived_at && ` · archived ${new Date(w.archived_at).toLocaleDateString()}`}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-[11px] text-muted-foreground"
                  onClick={() => setOpen(open === w.id ? null : w.id)}
                >
                  <Users className="size-3" />
                  Roster
                  <ChevronDown
                    className={cn("size-3 transition-transform", open === w.id && "rotate-180")}
                  />
                </Button>
                {w.status === "archived" ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 text-[11px]"
                    onClick={() => unarchive.mutate(w.id)}
                    disabled={unarchive.isPending}
                  >
                    <ArchiveRestore className="size-3" />
                    Un-archive
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-[11px] text-muted-foreground"
                    onClick={() => archive.mutate(w.id)}
                    disabled={archive.isPending}
                  >
                    <Archive className="size-3" />
                    Archive
                  </Button>
                )}
              </div>
            </div>

            {open === w.id && <AdminRoster workshop={w} />}
          </div>
        ))}
      </div>
    </section>
  );
}

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
        status === "archived"
          ? "border-border text-muted-foreground"
          : status === "completed"
            ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
            : "border-border text-muted-foreground",
      )}
    >
      {status}
    </span>
  );
}

/** One workshop's roster, with role changes and revocation. */
function AdminRoster({ workshop }: { workshop: AdminWorkshop }) {
  const queryClient = useQueryClient();
  const archived = workshop.status === "archived";

  const rosterQuery = useQuery({
    queryKey: ["admin-workshop-participants", workshop.id],
    queryFn: () => adminApi.workshopParticipants(workshop.id),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["admin-workshop-participants", workshop.id] });
    queryClient.invalidateQueries({ queryKey: ["admin-workshops"] });
  };

  const setRole = useMutation({
    mutationFn: (v: { userId: string; role: ParticipantRole }) =>
      participantsApi.setRole(workshop.id, v.userId, v.role),
    onSuccess: () => {
      refresh();
      toast.success("Role updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const revoke = useMutation({
    mutationFn: (userId: string) => participantsApi.revoke(workshop.id, userId),
    onSuccess: () => {
      refresh();
      toast.success("Access revoked");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const people = rosterQuery.data ?? [];

  return (
    <div className="border-t border-border bg-elevated/40 px-4 py-3">
      {rosterQuery.isLoading && (
        <p className="text-xs text-muted-foreground">Loading the roster…</p>
      )}
      {!rosterQuery.isLoading && people.length === 0 && (
        <p className="text-xs text-muted-foreground">Nobody has access to this workshop.</p>
      )}
      {archived && people.length > 0 && (
        <p className="mb-2 text-[11px] text-muted-foreground">
          This workshop is archived. Membership can still be changed — archiving freezes the
          workshop's content, not who may open it.
        </p>
      )}

      <ul className="space-y-1.5">
        {people.map((p: Participant) => (
          <li key={p.user_id} className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-xs">
                <span className="text-foreground">{p.name}</span>{" "}
                <span className="text-muted-foreground">{p.email}</span>
              </p>
              <p className="font-mono text-[10px] text-muted-foreground">
                {roleLabels[p.role]}
                {p.has_signed_in ? " · has signed in" : " · never signed in"}
                {!p.in_workspace && " · NO WORKSPACE ACCESS"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <select
                value={p.role}
                aria-label={`Role for ${p.name}`}
                onChange={(e) => setRole.mutate({ userId: p.user_id, role: e.target.value as ParticipantRole })}
                className="rounded border border-border bg-background px-1.5 py-1 font-mono text-[10px]"
              >
                {(Object.keys(roleLabels) as ParticipantRole[]).map((r) => (
                  <option key={r} value={r}>
                    {roleLabels[r]}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-[10px] text-muted-foreground hover:text-destructive"
                onClick={() => revoke.mutate(p.user_id)}
                disabled={revoke.isPending}
              >
                Revoke
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
