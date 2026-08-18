import { Link, useRouterState } from "@tanstack/react-router";
import {
  Bell,
  ChevronLeft,
  Compass,
  Database,
  LayoutDashboard,
  Moon,
  Settings,
  Shield,
  SignalHigh,
  Sun,
  FileText,
  Layers,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GlobalSearch } from "@/components/GlobalSearch";
import { useWorkshop } from "@/lib/workshop-store";
import { useUiPrefs } from "@/lib/ui-prefs";
import { roleLabels, type Role } from "@/lib/workshop-data";



const navItems = [
  { label: "Dashboard", icon: LayoutDashboard, to: "/" },
  { label: "Workshops", icon: Layers, to: "/" },
  { label: "Analysis", icon: Compass, to: "/discovery/strengths" },
  { label: "Reports", icon: FileText, to: "/prioritization" },
  { label: "Knowledge", icon: Database, to: "/" },
  { label: "Administration", icon: Shield, to: "/" },
];

const notifications = [
  "Sarah requested approval on theme “Talent Resilience”",
  "AI review completed for Insight Generation",
  "Report published: Executive Summary v1.0",
  "Ravi Menon accepted your workshop invitation",
];

export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const { role, setRole } = useWorkshop();
  const { theme, toggleTheme, showBuildStatus, toggleBuildStatus } = useUiPrefs();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const activeLabel =
    pathname === "/" ? "Dashboard" : pathname.startsWith("/discovery") ? "Analysis" : "Reports";

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border bg-sidebar/95 px-3 backdrop-blur md:px-4">
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
              ? "Build status ON — green outline = functional, red dashed = mock UI"
              : "Build status OFF"
          }
        >
          <SignalHigh className="size-4" />
        </Button>

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

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="relative shrink-0"
              aria-label="Notifications"
              data-build="mock"
            >
              <Bell className="size-4" />
              <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-accent" />
            </Button>
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end" className="w-80">
            <DropdownMenuLabel>Notifications</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {notifications.map((n) => (
              <DropdownMenuItem key={n} className="whitespace-normal text-xs leading-relaxed">
                {n}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-9 shrink-0 gap-2 px-2">
              <span className="grid size-6 place-items-center rounded-full bg-elevated text-[10px] font-semibold">
                YO
              </span>
              <span className="hidden text-xs text-muted-foreground md:inline">{roleLabels[role]}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Viewing as</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={role} onValueChange={(v) => setRole(v as Role)}>
              {(Object.keys(roleLabels) as Role[]).map((r) => (
                <DropdownMenuRadioItem key={r} value={r}>
                  {roleLabels[r]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem>Profile</DropdownMenuItem>
            <DropdownMenuItem>Settings</DropdownMenuItem>
            <DropdownMenuItem>Help</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem>Log out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="flex">
        <nav
          className={cn(
            "sticky top-14 hidden h-[calc(100vh-3.5rem)] shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-2 transition-all md:flex",
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
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-elevated/60 px-4 py-2 text-[11px] text-muted-foreground">
              <span className="label-caps">Build status</span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-0 w-4 border-t-2 border-success" /> Functional — real
                interactions and state
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-0 w-4 border-t-2 border-dashed border-destructive" /> Mock UI — no
                backend behind it
              </span>
            </div>
          )}
          {children}
        </main>

      </div>

      <nav className="sticky bottom-0 z-30 flex items-center justify-around border-t border-sidebar-border bg-sidebar px-2 py-1.5 md:hidden">
        {navItems.slice(0, 4).map((item) => (
          <Link
            key={item.label}
            to={item.to}
            className={cn(
              "flex flex-col items-center gap-0.5 rounded-md px-3 py-1 text-[10px]",
              item.label === activeLabel ? "text-primary" : "text-muted-foreground",
            )}
          >
            <item.icon className="size-4" />
            {item.label}
          </Link>
        ))}
        <button className="flex flex-col items-center gap-0.5 px-3 py-1 text-[10px] text-muted-foreground">
          <Settings className="size-4" />
          More
        </button>
      </nav>
    </div>
  );
}
