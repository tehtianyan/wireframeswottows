import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, ShieldAlert, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AdminWorkshops } from "@/components/admin/AdminWorkshops";
import { OneTimeLink } from "@/components/OneTimeLink";
import { PanelHeading } from "@/components/workshop-ui";
import { cn } from "@/lib/utils";
import {
  adminApi,
  describeActivity,
  type AdminUser,
  type InviteResult,
  type ResetLinkResult,
} from "@/lib/api";

// Administration (App Spec §11.29) plus the audit viewer (§11.28).
//
// Gated server-side on profiles.global_role; this page simply reports what
// the API says rather than deciding anything itself. A non-admin gets a plain
// explanation instead of an empty screen.

export const Route = createFileRoute("/admin")({
  component: AdminPage,
});

function AdminPage() {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ email: "", name: "", global_role: "user" });
  // One slot for whichever link was last minted — an invite or a reset. Shown
  // once; the server never records it, because until it is used it IS a
  // credential for that account.
  const [link, setLink] = useState<
    { email: string; link?: string; kind?: "invite" | "recovery"; error?: string } | null
  >(null);

  const usersQuery = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => adminApi.users(),
    retry: false,
  });
  const auditQuery = useQuery({
    queryKey: ["audit-events"],
    queryFn: () => adminApi.auditEvents(),
    retry: false,
    enabled: usersQuery.isSuccess,
  });

  const setRole = useMutation({
    mutationFn: (v: { id: string; role: string }) => adminApi.setRole(v.id, v.role),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      toast.success("Role updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const createUser = useMutation({
    mutationFn: () =>
      adminApi.createUser({
        email: form.email.trim(),
        ...(form.name.trim() ? { name: form.name.trim() } : {}),
        global_role: form.global_role,
      }),
    onSuccess: (r: InviteResult) => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      setForm({ email: "", name: "", global_role: "user" });
      setAddOpen(false);
      setLink({
        email: r.email,
        ...(r.invite_link ? { link: r.invite_link } : {}),
        ...(r.link_type ? { kind: r.link_type } : {}),
        ...(r.link_error ? { error: r.link_error } : {}),
      });
      toast.success(
        r.new_account ? `Account created for ${r.email}` : `${r.email} already had an account`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const resetPassword = useMutation({
    mutationFn: (id: string) => adminApi.resetPassword(id),
    onSuccess: (r: ResetLinkResult) => {
      setLink({ email: r.email, link: r.reset_link, kind: "recovery" });
      toast.success(`Reset link ready for ${r.email}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const setStatus = useMutation({
    mutationFn: (v: { id: string; status: "active" | "disabled" }) =>
      adminApi.setStatus(v.id, v.status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      toast.success("Status updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (usersQuery.isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (usersQuery.isError) {
    return (
      <div className="grid-backdrop min-h-[calc(100vh-3.5rem)]">
        <div className="mx-auto max-w-2xl p-6">
          <section className="console-panel p-6 text-center" data-build="live">
            <ShieldAlert className="mx-auto size-6 text-muted-foreground" />
            <h1 className="mt-3 text-lg font-semibold">Administration is restricted</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Your account is not a platform administrator. Ask an administrator if you need
              access to user management.
            </p>
          </section>
        </div>
      </div>
    );
  }

  const users = usersQuery.data ?? [];

  return (
    <div className="grid-backdrop min-h-[calc(100vh-3.5rem)]">
      <div className="mx-auto max-w-[1400px] space-y-4 p-3 md:p-5">
        <div>
          <h1 className="text-xl font-semibold md:text-2xl">Administration</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Platform-wide user management and the audit trail.
          </p>
        </div>

        <section className="console-panel" data-build="live">
          <PanelHeading
            build="live"
            title="Users"
            hint={`${users.length} accounts`}
            action={
              <Button variant="secondary" size="sm" onClick={() => setAddOpen((v) => !v)}>
                <UserPlus className="size-3.5" />
                Add user
              </Button>
            }
          />

          {addOpen && (
            <div className="space-y-2 border-b border-border bg-elevated/40 p-4">
              <p className="label-caps">Create an account</p>
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
              <select
                value={form.global_role}
                onChange={(e) => setForm((f) => ({ ...f, global_role: e.target.value }))}
                aria-label="Platform role"
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
              <p className="text-[11px] leading-snug text-muted-foreground">
                Works with a real email address. No mail is sent — you get a one-time link to pass
                on, and they choose their own password. Add them to a workshop from its
                Participants panel, or from the Workshops list below.
              </p>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setAddOpen(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={!form.email.trim() || createUser.isPending}
                  onClick={() => createUser.mutate()}
                >
                  {createUser.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  Create
                </Button>
              </div>
            </div>
          )}

          {link && (
            <OneTimeLink
              email={link.email}
              {...(link.link ? { link: link.link } : {})}
              {...(link.kind ? { kind: link.kind } : {})}
              {...(link.error ? { error: link.error } : {})}
              onDismiss={() => setLink(null)}
            />
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-4 py-2.5 font-medium">Account</th>
                  <th className="px-4 py-2.5 font-medium">Platform role</th>
                  <th className="px-4 py-2.5 font-medium">Workshops</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Password</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <UserRow
                    key={u.id}
                    user={u}
                    onRole={(role) => setRole.mutate({ id: u.id, role })}
                    onStatus={(status) => setStatus.mutate({ id: u.id, status })}
                    onReset={() => resetPassword.mutate(u.id)}
                    resetting={resetPassword.isPending && resetPassword.variables === u.id}
                    busy={setRole.isPending || setStatus.isPending}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <AdminWorkshops />

        <section className="console-panel" data-build="live">
          <PanelHeading
            build="live"
            title="Audit trail"
            hint={`${(auditQuery.data ?? []).length} most recent events`}
          />
          {auditQuery.isLoading ? (
            <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Loading…
            </div>
          ) : (auditQuery.data ?? []).length === 0 ? (
            <p className="p-4 text-xs text-muted-foreground">No audit events recorded.</p>
          ) : (
            <ul className="divide-y divide-border">
              {(auditQuery.data ?? []).map((e, i) => (
                <li key={i} className="flex items-baseline gap-3 px-4 py-2">
                  <span className="min-w-0 flex-1 text-xs">
                    <span className="font-medium">{e.actor_name}</span>{" "}
                    <span className="text-muted-foreground">{describeActivity(e)}</span>
                    {e.new_state && (
                      <span className="ml-1.5 rounded border border-border px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {e.new_state}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {new Date(e.created_at).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function UserRow({
  user,
  onRole,
  onStatus,
  onReset,
  resetting,
  busy,
}: {
  user: AdminUser;
  onRole: (role: string) => void;
  onStatus: (status: "active" | "disabled") => void;
  onReset: () => void;
  resetting: boolean;
  busy: boolean;
}) {
  return (
    <tr className="border-b border-border/60">
      <td className="px-4 py-2.5">
        <span className="block font-medium">{user.display_name ?? user.email}</span>
        {user.display_name && (
          <span className="block font-mono text-[10px] text-muted-foreground">{user.email}</span>
        )}
      </td>
      <td className="px-4 py-2.5">
        <select
          value={user.global_role}
          onChange={(e) => onRole(e.target.value)}
          disabled={busy}
          className="rounded-md border border-border bg-background px-2 py-1 text-xs"
          aria-label={`Platform role for ${user.email}`}
        >
          <option value="user">User</option>
          <option value="admin">Admin</option>
          <option value="platform_admin">Platform admin</option>
        </select>
      </td>
      <td className="px-4 py-2.5 font-mono text-muted-foreground">{user.workshop_count}</td>
      <td className="px-4 py-2.5">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => onStatus(user.status === "active" ? "disabled" : "active")}
          className={cn(
            "h-7 font-mono text-[10px] uppercase tracking-wider",
            user.status === "active"
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-destructive",
          )}
        >
          {user.status}
        </Button>
      </td>
      <td className="px-4 py-2.5">
        {/* A link, never a password an admin chooses: an admin who sets
            another person’s password knows it, and that person cannot tell
            whether it was ever used. Refused for a disabled account, because
            that would hand back access deliberately withdrawn. */}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-[11px] text-muted-foreground"
          onClick={onReset}
          disabled={resetting || user.status !== "active"}
          title={
            user.status === "active"
              ? "Generate a one-time link so they can set a new password"
              : "Re-enable the account first"
          }
        >
          {resetting ? <Loader2 className="size-3 animate-spin" /> : <KeyRound className="size-3" />}
          Reset link
        </Button>
      </td>
    </tr>
  );
}
