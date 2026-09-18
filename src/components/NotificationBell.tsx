import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Bell, Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { notificationsApi } from "@/lib/api";

// A real notification bell.
//
// The one this replaces showed four hardcoded strings, including a published
// report that never existed. These come from actual state transitions
// (App Spec §8.32) and are addressed to one recipient — the person whose work
// was acted on, never the person who acted.

export function NotificationBell() {
  const queryClient = useQueryClient();

  const { data: notifications = [] } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => notificationsApi.list(),
    // A workshop is collaborative, so new decisions land while you are looking
    // at the page.
    refetchInterval: 60_000,
  });

  const markRead = useMutation({
    mutationFn: (id: string) => notificationsApi.markRead(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const markAll = useMutation({
    mutationFn: () => notificationsApi.markAllRead(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => notificationsApi.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const unread = notifications.filter((n) => !n.is_read).length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative shrink-0"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        >
          <Bell className="size-4" />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-accent px-1 text-[9px] font-semibold text-accent-foreground">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-96">
        <div className="flex items-center justify-between px-2 py-1.5">
          <DropdownMenuLabel className="p-0">Notifications</DropdownMenuLabel>
          {unread > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-[11px]"
              onClick={() => markAll.mutate()}
              disabled={markAll.isPending}
            >
              {markAll.isPending ? <Loader2 className="size-3 animate-spin" /> : null}
              Mark all read
            </Button>
          )}
        </div>
        <DropdownMenuSeparator />

        {notifications.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-muted-foreground">
            Nothing yet. You will hear when someone reviews your work.
          </p>
        ) : (
          <ul className="max-h-96 overflow-y-auto">
            {notifications.map((n) => (
              <li
                key={n.id}
                className={cn(
                  "group flex items-start gap-2 px-3 py-2.5 transition-colors hover:bg-elevated",
                  !n.is_read && "bg-elevated/50",
                )}
              >
                <span
                  className={cn(
                    "mt-1.5 size-1.5 shrink-0 rounded-full",
                    n.is_read ? "bg-transparent" : "bg-accent",
                  )}
                />
                <div className="min-w-0 flex-1">
                  {n.workshop_id ? (
                    <Link
                      to="/w/$workshopId"
                      params={{ workshopId: n.workshop_id }}
                      onClick={() => !n.is_read && markRead.mutate(n.id)}
                      className="block"
                    >
                      <p className="text-xs font-medium leading-snug">{n.title}</p>
                    </Link>
                  ) : (
                    <p className="text-xs font-medium leading-snug">{n.title}</p>
                  )}
                  {n.body && (
                    <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{n.body}</p>
                  )}
                  <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                    {new Date(n.created_at).toLocaleString()}
                  </p>
                </div>
                <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  {!n.is_read && (
                    <button
                      onClick={() => markRead.mutate(n.id)}
                      className="rounded p-1 text-muted-foreground hover:text-foreground"
                      aria-label="Mark read"
                    >
                      <Check className="size-3" />
                    </button>
                  )}
                  <button
                    onClick={() => remove.mutate(n.id)}
                    className="rounded p-1 text-muted-foreground hover:text-destructive"
                    aria-label="Dismiss"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
