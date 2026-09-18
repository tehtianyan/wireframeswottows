import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Layers, Search, Workflow } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { dashboardApi, workshopsApi } from "@/lib/api";

// Global search over the caller's real workshops and their stages.
//
// This previously searched a set of static in-memory arrays and
// navigated to the mock /discovery and /prioritization screens — so it could
// return results for artifacts that did not exist and route to pages that
// were no longer the real path. It now searches what the API actually
// returns, and every result goes to a live route.

type Result = {
  id: string;
  label: string;
  detail: string;
  kind: "workshop" | "stage";
  workshopId: string;
  stageKey?: string;
};

export function GlobalSearch() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Reuses the dashboard query, so opening search costs no extra request on
  // any page that has already loaded it.
  const { data: dashboard } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => dashboardApi.get(),
    staleTime: 30_000,
  });

  // Stage names need the methodology, which only the workshop detail carries.
  // Fetched only once the user actually types.
  const workshopIds = (dashboard?.workshops ?? []).map((w) => w.id);
  const { data: details } = useQuery({
    queryKey: ["search-stages", workshopIds],
    queryFn: async () => Promise.all(workshopIds.map((id) => workshopsApi.get(id))),
    enabled: query.trim().length > 1 && workshopIds.length > 0,
    staleTime: 60_000,
  });

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const results = useMemo<Result[]>(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const out: Result[] = [];

    for (const w of dashboard?.workshops ?? []) {
      if (w.name.toLowerCase().includes(q)) {
        out.push({
          id: w.id, label: w.name, kind: "workshop", workshopId: w.id,
          detail: `${w.methodology_name} · ${w.status}`,
        });
      }
    }

    for (const d of details ?? []) {
      for (const s of d.methodology.stages) {
        if (s.name.toLowerCase().includes(q) || s.key.toLowerCase().includes(q)) {
          out.push({
            id: `${d.id}:${s.key}`, label: s.name, kind: "stage",
            workshopId: d.id, stageKey: s.key,
            detail: `${d.name} · stage ${s.sequence_number}`,
          });
        }
      }
    }
    return out.slice(0, 8);
  }, [query, dashboard, details]);

  function select(r: Result) {
    setOpen(false);
    setQuery("");
    if (r.kind === "stage" && r.stageKey) {
      navigate({
        to: "/w/$workshopId/stage/$stageKey",
        params: { workshopId: r.workshopId, stageKey: r.stageKey },
        search: {},
      });
    } else {
      navigate({ to: "/w/$workshopId", params: { workshopId: r.workshopId } });
    }
  }

  return (
    <div ref={wrapRef} className="relative ml-auto w-full max-w-sm" data-build="live">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
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
        placeholder="Search workshops and stages…"
        className="h-9 pl-8 text-xs"
        aria-label="Global search"
      />

      {open && query.trim().length > 1 && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-md border border-border bg-popover shadow-lg">
          {results.length === 0 ? (
            <p className="px-3 py-2.5 text-xs text-muted-foreground">No matches.</p>
          ) : (
            <ul>
              {results.map((r) => (
                <li key={r.id}>
                  <button
                    onClick={() => select(r)}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-elevated",
                    )}
                  >
                    {r.kind === "workshop" ? (
                      <Layers className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <Workflow className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium">{r.label}</span>
                      <span className="block truncate font-mono text-[10px] text-muted-foreground">
                        {r.detail}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
