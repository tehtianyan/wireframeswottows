import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { participantsApi } from "@/lib/api";

// Archive / un-archive one workshop.
//
// `archived` was legal in the workshops status CHECK from the beginning and had
// no way to be reached from anywhere — the lifecycle's last state existed only
// on paper.
//
// Archiving FREEZES the workshop and keeps it listed: its reports and the
// knowledge promoted from it stay readable, because archiving is for finishing
// with a workshop rather than for hiding it from organisational memory. The
// freeze is enforced by a database trigger, so it holds for every write path
// including ones added later.
//
// It is reversible, which is why there is a confirmation step rather than a
// typed-name ritual: the cost of getting it wrong is one more click.

export function ArchiveWorkshopControl({
  workshopId,
  status,
}: {
  workshopId: string;
  status: string;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const archived = status === "archived";

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["workshop", workshopId] });
    queryClient.invalidateQueries({ queryKey: ["workshops"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const archive = useMutation({
    mutationFn: () => participantsApi.archive(workshopId),
    onSuccess: () => {
      invalidate();
      setConfirming(false);
      toast.success("Workshop archived. It is read-only until you un-archive it.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const unarchive = useMutation({
    mutationFn: () => participantsApi.unarchive(workshopId),
    onSuccess: (r) => {
      invalidate();
      toast.success(`Un-archived. The workshop is back to ${r.status}.`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (archived) {
    return (
      <Button
        size="sm"
        variant="secondary"
        onClick={() => unarchive.mutate()}
        disabled={unarchive.isPending}
      >
        {unarchive.isPending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <ArchiveRestore className="size-3.5" />
        )}
        Un-archive
      </Button>
    );
  }

  if (!confirming) {
    return (
      <Button
        size="sm"
        variant="ghost"
        className="text-muted-foreground"
        onClick={() => setConfirming(true)}
      >
        <Archive className="size-3.5" />
        Archive
      </Button>
    );
  }

  return (
    <div className="rounded-sm border border-border bg-elevated/60 p-2.5">
      <p className="max-w-xs text-xs leading-snug text-muted-foreground">
        Archive this workshop? It becomes read-only — no capture, votes, AI or review — but stays
        listed and its reports stay readable. You can un-archive it at any time.
      </p>
      <div className="mt-2 flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => archive.mutate()} disabled={archive.isPending}>
          {archive.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Archive
        </Button>
      </div>
    </div>
  );
}
