import { useNavigate } from "@tanstack/react-router";
import { Compass, FileText, Lightbulb, Search, Sparkles, User } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useWorkshop } from "@/lib/workshop-store";
import {
  categoryMeta,
  insights,
  participants,
  roleLabels,
  themes,
} from "@/lib/workshop-data";

type ResultGroup = "Artifacts" | "Themes & insights" | "Screens" | "Participants";

interface SearchResult {
  id: string;
  group: ResultGroup;
  label: string;
  detail: string;
  to?: string;
  icon: typeof Search;
}

const screens: { label: string; detail: string; to: string }[] = [
  { label: "Workshop Dashboard", detail: "Progress, activities, intelligence", to: "/" },
  ...(["strength", "weakness", "opportunity", "threat"] as const).map((c) => ({
    label: categoryMeta[c].activity,
    detail: "Discovery workspace",
    to: `/discovery/${categoryMeta[c].slug}`,
  })),
  { label: "Prioritization", detail: "Voting, rankings, heat map", to: "/prioritization" },
];

export function GlobalSearch() {
  const { artifacts } = useWorkshop();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const results = useMemo<SearchResult[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: SearchResult[] = [];

    for (const a of artifacts) {
      const hay = `${a.title} ${a.description} ${a.tags.join(" ")}`.toLowerCase();
      if (hay.includes(q)) {
        out.push({
          id: `a-${a.id}`,
          group: "Artifacts",
          label: a.title,
          detail: `${categoryMeta[a.category].label} · ${a.votes} votes · ${a.author}`,
          to: `/discovery/${categoryMeta[a.category].slug}`,
          icon: FileText,
        });
      }
    }

    for (const t of themes) {
      if (t.name.toLowerCase().includes(q)) {
        out.push({
          id: `t-${t.id}`,
          group: "Themes & insights",
          label: t.name,
          detail: `Theme · ${t.artifactCount} artifacts · ${t.confidence}% confidence`,
          to: "/",
          icon: Sparkles,
        });
      }
    }
    for (const i of insights) {
      const hay = `${i.title} ${i.supportingThemes.join(" ")}`.toLowerCase();
      if (hay.includes(q)) {
        out.push({
          id: `i-${i.id}`,
          group: "Themes & insights",
          label: i.title,
          detail: `Insight · ${i.significance} significance`,
          to: "/",
          icon: Lightbulb,
        });
      }
    }

    for (const s of screens) {
      if (`${s.label} ${s.detail}`.toLowerCase().includes(q)) {
        out.push({
          id: `s-${s.to}-${s.label}`,
          group: "Screens",
          label: s.label,
          detail: s.detail,
          to: s.to,
          icon: Compass,
        });
      }
    }

    for (const p of participants) {
      if (`${p.name} ${roleLabels[p.role]}`.toLowerCase().includes(q)) {
        out.push({
          id: `p-${p.id}`,
          group: "Participants",
          label: p.name,
          detail: `${roleLabels[p.role]} · ${p.presence}`,
          icon: User,
        });
      }
    }

    return out.slice(0, 24);
  }, [query, artifacts]);

  const grouped = useMemo(() => {
    const order: ResultGroup[] = ["Artifacts", "Themes & insights", "Screens", "Participants"];
    return order
      .map((g) => ({ group: g, items: results.filter((r) => r.group === g) }))
      .filter((g) => g.items.length > 0);
  }, [results]);

  function select(r: SearchResult) {
    if (r.to) {
      navigate({ to: r.to });
      setOpen(false);
      setQuery("");
    }
  }

  return (
    <div ref={wrapRef} className="relative ml-auto w-full max-w-sm" data-build="live">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          if (e.key === "Enter" && results[0]) select(results[0]);
        }}
        placeholder="Search workshops, artifacts, themes, insights…"
        className="h-9 border-border bg-elevated pl-8 text-sm placeholder:text-muted-foreground/70"
        aria-label="Global search"
      />

      {open && query.trim() && (
        <div className="absolute left-0 right-0 top-11 z-50 max-h-[70vh] overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg">
          {grouped.length === 0 && (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              No matches for “{query.trim()}”
            </p>
          )}
          {grouped.map((g) => (
            <div key={g.group} className="py-1">
              <p className="label-caps px-2.5 py-1 text-[10px] text-muted-foreground">{g.group}</p>
              {g.items.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => select(r)}
                  disabled={!r.to}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-sm px-2.5 py-1.5 text-left",
                    r.to ? "hover:bg-elevated" : "cursor-default opacity-80",
                  )}
                >
                  <r.icon className="mt-0.5 size-3.5 shrink-0 text-primary" />
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">{r.label}</span>
                    <span className="block truncate font-mono text-[10px] text-muted-foreground">
                      {r.detail}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
