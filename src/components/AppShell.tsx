import { Link, useRouterState } from "@tanstack/react-router";
import { BookMarked, ChevronLeft, Gauge, LayoutDashboard, Layers, Moon, Shield, SignalHigh, Sun } from "lucide-react";
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
import { useUiPrefs } from "@/lib/ui-prefs";
import { supabase } from "@/integrations/supabase/client";



// Every destination here exists. Administration shows a plain "restricted"
// message to non-admins rather than being hidden, so people can tell the
// difference between "you cannot" and "there is nothing here".
// `short` is what the mobile bottom bar uses: five items at 375px cannot
// carry "Administration" without wrapping or clipping.
const navItems = [
  { label: "Dashboard", short: "Home", icon: LayoutDashboard, to: "/" },
  { label: "Workshops", short: "Work", icon: Layers, to: "/w" },
  { label: "Executive", short: "Exec", icon: Gauge, to: "/executive" },
  { label: "Knowledge", short: "Know", icon: BookMarked, to: "/knowledge" },
  { label: "Administration", short: "Admin", icon: Shield, to: "/admin" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const { theme, toggleTheme, showBuildStatus, toggleBuildStatus } = useUiPrefs();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

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
          ? "Workshops"
          : "Dashboard";

  return (
    <div className="min-h-screen bg-background">
      <header className="print:hidden sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border bg-sidebar/95 px-3 backdrop-blur md:px-4">
        <Link to="/" className="flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-md bg-primary font-display text-sm font-bold text-primary-foreground">
            ST
          </span>
          <span className="hidden font-display text-sm font-semibold tracking-tight sm:inline">
            SWOT·TOWS Console
          </span>
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
            "print:hidden sticky top-14 hidden h-[calc(100vh-3.5rem)] shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-2 transition-all md:flex",
            collapsed ? "w-14" : "w-52",
          )}
        >
          {navItems.map((item) => {
            const isActive = item.label === activeLabel;
            return (
              <Link
                key={item.label}
                to={item.to}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground",
                  isActive && "bg-sidebar-accent text-sidebar-foreground",
                )}
              >
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
        {navItems.map((item) => (
          <Link
            key={item.label}
            to={item.to}
            className={cn(
              "flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-md px-1 py-1 text-[10px]",
              item.label === activeLabel ? "text-primary" : "text-muted-foreground",
            )}
          >
            <item.icon className="size-4 shrink-0" />
            <span className="truncate">{item.short}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
