import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { workshopsApi } from "@/lib/api";

// The live workshop list, backed by the Go API. This is the entry point into
// the generic stage renderer — the dashboard at "/" is still the earlier
// mock-data screen and is left alone until it moves onto the API.

export const Route = createFileRoute("/w/")({
  component: WorkshopsPage,
});

const STATUS_STYLES: Record<string, string> = {
  draft: "border-border text-muted-foreground",
  configured: "border-sky-500/40 text-sky-600 dark:text-sky-400",
  active: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
  analysis: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  reporting: "border-violet-500/40 text-violet-600 dark:text-violet-400",
  completed: "border-border text-muted-foreground",
  archived: "border-border text-muted-foreground",
};

function WorkshopsPage() {
  const workshopsQuery = useQuery({
    queryKey: ["workshops"],
    queryFn: () => workshopsApi.list(),
  });

  return (
    <div className="grid-backdrop min-h-[calc(100vh-3.5rem)]">
      <div className="mx-auto max-w-[1100px] space-y-4 p-3 md:p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold md:text-2xl">Workshops</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              Every workshop you are a member of, live from the API.
            </p>
          </div>
          <Button asChild size="sm">
            <Link to="/w/new">
              <Plus className="size-3.5" />
              New workshop
            </Link>
          </Button>
        </div>

        <section className="console-panel" data-build="live">
          {workshopsQuery.isLoading && (
            <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Loading workshops…
            </div>
          )}
          {workshopsQuery.isError && (
            <p className="p-4 text-xs text-destructive">Could not load your workshops.</p>
          )}
          {workshopsQuery.data?.length === 0 && (
            <div className="p-6 text-center">
              <p className="text-sm text-muted-foreground">You are not a member of any workshop yet.</p>
              <Button asChild size="sm" className="mt-3">
                <Link to="/w/new">Create your first workshop</Link>
              </Button>
            </div>
          )}

          <div className="divide-y divide-border">
            {workshopsQuery.data?.map((wk) => (
              <Link
                key={wk.id}
                to="/w/$workshopId"
                params={{ workshopId: wk.id }}
                className="block px-4 py-3.5 transition-colors hover:bg-elevated/50"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{wk.name}</p>
                    {wk.objective && (
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{wk.objective}</p>
                    )}
                    <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">
                      Created {new Date(wk.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
                      STATUS_STYLES[wk.status] ?? "border-border text-muted-foreground",
                    )}
                  >
                    {wk.status}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
