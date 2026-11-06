import { useState, type ReactNode } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { describeActivity, type ActivityEvent } from "@/lib/api";

/**
 * A panel moved off the page and behind a link.
 *
 * A drawer rather than a collapsed section: a disclosure still costs a row of
 * the page each, and these are read occasionally about work the reader is
 * already doing. THE COUNT IS ON THE LINK, so the glance the panel was there
 * for — how many people, has anything happened — is answered without opening
 * anything.
 *
 * Shared by the workshop overview and the dashboard. It was the overview's own
 * local component until the dashboard's "Recent activity" needed the same
 * treatment, and two copies of this would have drifted the way the two presence
 * channels did.
 *
 * NOTHING INSIDE A DRAWER MAY BE LOAD-BEARING WHILE CLOSED: Radix unmounts the
 * content, so a component in here must not be the only thing doing some piece
 * of work. That exact mistake is why nobody ever appeared in the Participants
 * panel — it was the only thing announcing presence, and it only existed while
 * the drawer was open.
 */
export function DrawerLink({
  icon,
  label,
  count,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  label: string;
  count: number | undefined;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground"
        >
          {icon}
          {label}
          {count !== undefined && (
            <span className="font-mono text-[10px] tabular-nums">{count}</span>
          )}
        </button>
      </SheetTrigger>
      {/* Wider than the default sm:max-w-sm: the roster carries a role control
          and an invite form, which a narrow drawer wraps into unreadability. */}
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <div className="mt-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

/** The audit trail, newest first. Shared by the dashboard and the overview. */
export function ActivityList({
  events,
  emptyMessage = "Nothing has happened yet.",
}: {
  events: ActivityEvent[];
  emptyMessage?: string;
}) {
  if (events.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyMessage}</p>;
  }
  return (
    <ul className="divide-y divide-border">
      {events.map((e, i) => (
        <li key={i} className="py-2.5">
          <p className="text-xs">
            <span className="font-medium">{e.actor_name}</span>{" "}
            <span className="text-muted-foreground">{describeActivity(e)}</span>
          </p>
          <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
            {new Date(e.created_at).toLocaleString()}
          </p>
        </li>
      ))}
    </ul>
  );
}
