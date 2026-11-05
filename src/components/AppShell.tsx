import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  BookMarked,
  ChevronLeft,
  ChevronRight,
  Gauge,
  LayoutDashboard,
  Layers,
  Moon,
  Plus,
  Shield,
  SignalHigh,
  Sun,
} from "lucide-react";
import { SkinPicker } from "@/components/SkinPicker";
import { useEffect, useState, type ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GlobalSearch } from "@/components/GlobalSearch";
import { NotificationBell } from "@/components/NotificationBell";
import { BrandMark, useBrand } from "@/components/BrandMark";
import { useUiPrefs } from "@/lib/ui-prefs";
import { workshopsApi, type Workshop } from "@/lib/api";
import { supabase } from "@/integrations/supabase/client";



// Every destination here exists. Administration shows a plain "restricted"
// message to non-admins rather than being hidden, so people can tell the
// difference between "you cannot" and "there is nothing here".
// `short` is what the mobile bottom bar uses: five items at 375px cannot
// carry "Administration" without wrapping or clipping.
const navItems = [
  { label: "Dashboard", short: "Home", icon: LayoutDashboard, to: "/" },
  { label: "My Workshops", short: "Mine", icon: Layers, to: "/w" },
  { label: "Executive", short: "Exec", icon: Gauge, to: "/executive" },
  { label: "Knowledge", short: "Know", icon: BookMarked, to: "/knowledge" },
  { label: "Administration", short: "Admin", icon: Shield, to: "/admin" },
];

const WORKSHOPS_LABEL = "My Workshops";

/**
 * A workshop still in play.
 *
 * Phrased as what it EXCLUDES, which is the honest way round: the lifecycle is
 * Draft → Active → Analysis → Reporting → Completed → Archived (plus
 * "Configured"), and a menu of things to go and work on should carry everything
 * except the two that are finished. Listing only `status === "active"` would
 * hide a workshop that had reached Analysis — further along, not less current —
 * and anything still in Draft, which is exactly where a facilitator left off.
 * Completed and archived workshops stay reachable on the full list, where
 * their status is shown.
 */
const FINISHED = new Set(["completed", "archived"]);

/** Most recent first, so the menu is ordered by what you are likeliest to want. */
function inPlay(workshops: Workshop[]): Workshop[] {
  return workshops
    .filter((w) => !FINISHED.has(w.status))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const { theme, toggleTheme, showBuildStatus, toggleBuildStatus } = useUiPrefs();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const brand = useBrand();

  // The browser tab, too. __root's head() can only use the BUILD brand — it
  // runs before anybody is signed in, so no organization is known yet — which
  // meant setting a Display Name left the tab reading the old product name.
  // Same complaint, same cause, so it is fixed in the same place.
  useEffect(() => {
    if (typeof document !== "undefined") document.title = brand.name;
  }, [brand.name]);

  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setEmail(data.session?.user.email ?? null));
  }, []);
  const initials = (email ?? "?").slice(0, 2).toUpperCase();

  const activeLabel = pathname.startsWith("/executive")
    ? "Executive"
    : pathname.startsWith("/knowledge")
      ? "Knowledge"
      : pathname.startsWith("/admin")
        ? "Administration"
        : pathname.startsWith("/w")
          ? WORKSHOPS_LABEL
          : "Dashboard";

  return (
    <div className="min-h-screen bg-background">
      <header className="print:hidden sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border bg-sidebar/95 px-3 backdrop-blur md:px-4">
        <Link to="/" className="flex items-center gap-2">
          <BrandMark brand={brand} size={8} />
          {/* showWordmark, NOT !logoUrl. Gating on the logo meant the Display
              Name field silently did nothing once a logo was uploaded — a
              typed value with no visible effect anywhere. See Brand.showWordmark
              for the rule; brand.test.js pins all four combinations. */}
          {brand.showWordmark && (
            <span className="hidden font-display text-sm font-semibold tracking-tight sm:inline">
              {brand.shortName}
            </span>
          )}
        </Link>

        <GlobalSearch />


        <Button
          variant="ghost"
          size="icon"
          className={cn("shrink-0", showBuildStatus && "text-success")}
          onClick={toggleBuildStatus}
          aria-label="Toggle build status highlighting"
          title={
            showBuildStatus
              ? "Build status ON — green outline marks panels backed by the real API"
              : "Build status OFF"
          }
        >
          <SignalHigh className="size-4" />
        </Button>

        <NotificationBell />

        <SkinPicker />

        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          onClick={toggleTheme}
          aria-label={theme === "dark" ? "Switch to day mode" : "Switch to dark mode"}
          title={theme === "dark" ? "Switch to day mode" : "Switch to dark mode"}
        >
          {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>


        {/* No role switcher. Roles are real, per-workshop and enforced by the
            server; a header dropdown that appeared to change them was telling
            the user something untrue. The workshop pages show the caller's
            actual role. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-9 shrink-0 gap-2 px-2">
              <span className="grid size-6 place-items-center rounded-full bg-elevated text-[10px] font-semibold">
                {initials}
              </span>
              <span className="hidden max-w-[140px] truncate text-xs text-muted-foreground md:inline">
                {email ?? "Signed in"}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="truncate font-normal text-muted-foreground">
              {email ?? "Signed in"}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void supabase.auth.signOut()}>Log out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="flex">
        <nav
          className={cn(
            // overflow-y-auto because the workshops entry now discloses its
            // list INTO this column rather than into a popover beside it: a
            // long list would otherwise push the Collapse button off the
            // bottom, where nothing can reach it. `mt-auto` on that button
            // still pins it to the bottom whenever the column is short.
            "print:hidden sticky top-14 hidden h-[calc(100vh-3.5rem)] shrink-0 flex-col overflow-y-auto overscroll-contain border-r border-sidebar-border bg-sidebar p-2 transition-all md:flex",
            collapsed ? "w-14" : "w-52",
          )}
        >
          {navItems.map((item) => {
            const isActive = item.label === activeLabel;
            const classes = cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground",
              isActive && "bg-sidebar-accent text-sidebar-foreground",
            );

            // The workshops entry opens its list in place rather than
            // navigating to a screen whose only job was to list them.
            //
            // IN PLACE MEANS IN THIS COLUMN. It used to open a popover beside
            // the sidebar, which UAT read as the list arriving "at the right"
            // — detached from the word that produced it, and covering the
            // page. It is a disclosure now: the workshops appear directly
            // under the entry as sublinks and push the entries below them
            // down, which is the shape the menu already implied.
            if (item.label === WORKSHOPS_LABEL) {
              // A COLLAPSED RAIL IS THE ONE EXCEPTION, and it is not a
              // compromise. The rail is 56px and hides every label, so there
              // is nothing to disclose INTO: sublinks would have no room for
              // a workshop's name. The popover is the right shape there, and
              // the trigger is the icon.
              if (collapsed) {
                return (
                  <WorkshopsMenu key={item.label} align="start" side="right">
                    <button
                      type="button"
                      title={item.label}
                      className={cn(classes, "w-full text-left")}
                    >
                      <item.icon className={cn("size-4 shrink-0", isActive && "text-primary")} />
                    </button>
                  </WorkshopsMenu>
                );
              }

              return (
                <WorkshopsDisclosure
                  key={item.label}
                  label={item.label}
                  icon={item.icon}
                  isActive={isActive}
                  triggerClasses={classes}
                />
              );
            }

            return (
              <Link key={item.label} to={item.to} className={classes}>
                <item.icon className={cn("size-4 shrink-0", isActive && "text-primary")} />
                {!collapsed && <span className="truncate">{item.label}</span>}
              </Link>
            );
          })}
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="mt-auto flex items-center gap-2 rounded-md px-2.5 py-2 text-xs text-muted-foreground hover:bg-sidebar-accent"
          >
            <ChevronLeft className={cn("size-4 transition-transform", collapsed && "rotate-180")} />
            {!collapsed && <span>Collapse</span>}
          </button>
        </nav>

        <main className="min-w-0 flex-1">
          {showBuildStatus && (
            <div className="print:hidden flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-elevated/60 px-4 py-2 text-[11px] text-muted-foreground">
              <span className="label-caps">Build status</span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-0 w-4 border-t-2 border-success" /> Functional — real data,
                real permissions
              </span>
              {/* The "mock UI" half of this legend was removed along with the
                  mock screens: nothing in the app is mock any more, so a
                  legend entry for it described something that did not exist. */}
            </div>
          )}
          {children}
        </main>

      </div>

      <nav className="print:hidden sticky bottom-0 z-30 flex items-center justify-around border-t border-sidebar-border bg-sidebar px-2 py-1.5 md:hidden">
        {navItems.map((item) => {
          const classes = cn(
            "flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-md px-1 py-1 text-[10px]",
            item.label === activeLabel ? "text-primary" : "text-muted-foreground",
          );

          // Same menu on a phone. A sidebar disclosure would have been the
          // obvious shape for the desktop list, but there is no sidebar here to
          // disclose into, and the point is to reach a workshop in one tap
          // wherever you are.
          if (item.label === WORKSHOPS_LABEL) {
            return (
              <WorkshopsMenu key={item.label} align="center" side="top">
                <button type="button" className={classes}>
                  <item.icon className="size-4 shrink-0" />
                  <span className="truncate">{item.short}</span>
                </button>
              </WorkshopsMenu>
            );
          }

          return (
            <Link key={item.label} to={item.to} className={classes}>
              <item.icon className="size-4 shrink-0" />
              <span className="truncate">{item.short}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/**
 * The list both shapes render.
 *
 * ONE statement of it, because there are now two surfaces — the sidebar's
 * disclosure and the popover the phone and the collapsed rail use — and
 * "which workshops belong in the menu" is exactly the rule that would rot if
 * each one filtered for itself. The query key is shared with the full list
 * screen, so moving between them costs no extra request.
 *
 * `enabled` keeps the fetch lazy: the shell renders on every screen and most
 * of them have no use for this list, so nothing is requested until somebody
 * actually opens the menu.
 */
function useMyWorkshops(enabled: boolean) {
  const query = useQuery({
    queryKey: ["workshops"],
    queryFn: () => workshopsApi.list(),
    enabled,
  });
  return {
    live: inPlay(query.data ?? []),
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/** What the menu says above the list, in both shapes. */
function workshopsSummary(isLoading: boolean, count: number): string {
  if (isLoading) return "Loading…";
  return count === 0 ? "Nothing in progress" : `${count} in progress`;
}

/**
 * The workshops you are a member of, as a menu rather than a screen.
 *
 * Opening a workshop used to mean loading a list page and then clicking
 * through it — a whole navigation for a choice of half a dozen names. The
 * screen is still there (it carries each workshop's status, objective and the
 * New button) and is the last entry here, so nothing was taken away.
 *
 * The query is shared with that screen by key, so moving between them costs no
 * extra request, and a workshop created on the wizard appears here as soon as
 * the existing invalidation fires.
 */
function WorkshopsMenu({
  children,
  align,
  side,
}: {
  children: ReactNode;
  align: "start" | "center";
  side: "right" | "top";
}) {
  const [open, setOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { live, isLoading, isError } = useMyWorkshops(open);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} side={side} className="max-h-[70vh] w-64 overflow-y-auto">
        <DropdownMenuLabel className="font-normal text-muted-foreground">
          {workshopsSummary(isLoading, live.length)}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {live.map((w) => {
          const isHere = pathname.startsWith(`/w/${w.id}`);
          return (
            <DropdownMenuItem key={w.id} asChild>
              <Link
                to="/w/$workshopId"
                params={{ workshopId: w.id }}
                className="flex cursor-pointer items-center gap-2"
              >
                <span className={cn("min-w-0 flex-1 truncate text-xs", isHere && "font-semibold")}>
                  {w.name}
                </span>
                <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                  {w.status}
                </span>
              </Link>
            </DropdownMenuItem>
          );
        })}

        {isError && (
          <p className="px-2 py-1.5 text-xs text-destructive">Could not load your workshops.</p>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/w" className="cursor-pointer text-xs">
            <Layers className="size-3.5" />
            All workshops, with status
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/w/new" className="cursor-pointer text-xs">
            <Plus className="size-3.5" />
            New workshop
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The same workshops, disclosed INSIDE the sidebar.
 *
 * This is what the sidebar uses whenever it is expanded, and the difference
 * from WorkshopsMenu is the whole point of it: the list belongs to the column
 * it was opened from. It sits under the entry, indented against a rail so the
 * nesting is visible at a glance, and it PUSHES the entries below it down
 * rather than floating over the page. Nothing is covered, so the rest of the
 * navigation stays readable while you choose.
 *
 * It renders no list at all until it is open, which is what keeps
 * useMyWorkshops' fetch lazy — the shell is on every screen.
 *
 * Deliberately CLOSED on arrival, including on a workshop screen. Opening it
 * automatically would fetch the list on every one of those screens for a
 * disclosure nobody asked for, and shift the entries below on load. The
 * entry itself is already highlighted when you are inside a workshop, which
 * is what tells you where you are.
 */
function WorkshopsDisclosure({
  label,
  icon: Icon,
  isActive,
  triggerClasses,
}: {
  label: string;
  icon: typeof Layers;
  isActive: boolean;
  triggerClasses: string;
}) {
  const [open, setOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { live, isLoading, isError } = useMyWorkshops(open);

  const subLink =
    "flex items-center gap-2 rounded-md py-1.5 pl-2 pr-2 text-xs text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground";

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="sidebar-workshops"
        className={cn(triggerClasses, "w-full text-left")}
      >
        <Icon className={cn("size-4 shrink-0", isActive && "text-primary")} />
        <span className="truncate">{label}</span>
        {/* The one chevron, rotated — so the control states which way it is
            about to move rather than needing two icons kept in step. */}
        <ChevronRight
          className={cn(
            "ml-auto size-3.5 shrink-0 opacity-60 transition-transform",
            open && "rotate-90",
          )}
        />
      </button>

      {open && (
        <div
          id="sidebar-workshops"
          // Capped so a facilitator with thirty workshops cannot push
          // Executive, Knowledge and Administration off the bottom of the
          // column — the list is a way to reach a workshop, not a reason to
          // lose the rest of the navigation.
          //
          // THE CAP IS PROPORTIONAL, NOT A PIXEL COUNT. A fixed 16rem engaged
          // on ten workshops, which is an ordinary number, so a second
          // scrollbar appeared inside an already-scrolling column for a list
          // that would have fitted. Half the viewport leaves the remaining
          // entries half the column whatever the screen height, and on the
          // short screens where it does engage it engages for a real reason.
          // Measured, not guessed: see the geometry probe in the commit.
          className="mb-1 ml-4 max-h-[50vh] overflow-y-auto overscroll-contain border-l border-sidebar-border pl-1"
        >
          <p className="px-2 py-1 text-[10px] text-muted-foreground">
            {workshopsSummary(isLoading, live.length)}
          </p>

          {live.map((w) => {
            const isHere = pathname.startsWith(`/w/${w.id}`);
            return (
              <Link
                key={w.id}
                to="/w/$workshopId"
                params={{ workshopId: w.id }}
                onClick={() => setOpen(false)}
                // The full name on hover: this column is 175px wide against
                // the popover's 256px, so a real workshop name truncates
                // here where it did not before, and several of them share a
                // first word. Seen in a screenshot, not in the geometry.
                title={w.name}
                className={cn(subLink, isHere && "bg-sidebar-accent text-sidebar-foreground")}
              >
                <span className={cn("min-w-0 flex-1 truncate", isHere && "font-semibold")}>
                  {w.name}
                </span>
                <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                  {w.status}
                </span>
              </Link>
            );
          })}

          {isError && (
            <p className="px-2 py-1 text-xs text-destructive">Could not load your workshops.</p>
          )}

          <Link to="/w" onClick={() => setOpen(false)} className={subLink}>
            <Layers className="size-3.5 shrink-0" />
            <span className="truncate">All workshops, with status</span>
          </Link>
          <Link to="/w/new" onClick={() => setOpen(false)} className={subLink}>
            <Plus className="size-3.5 shrink-0" />
            <span className="truncate">New workshop</span>
          </Link>
        </div>
      )}
    </div>
  );
}
