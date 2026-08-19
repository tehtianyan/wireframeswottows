import { useMemo, useState } from "react";
import { CheckCircle2, ChevronDown, ClipboardCheck, RotateCcw, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PanelHeading } from "@/components/workshop-ui";
import { cn } from "@/lib/utils";
import { useCan, useWorkshop } from "@/lib/workshop-store";
import type { ApprovalDecision, ApprovalItem } from "@/lib/workshop-data";

const filters: { key: ApprovalDecision | "all"; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "all", label: "All" },
];

const decisionStyles: Record<ApprovalDecision, string> = {
  pending: "bg-warning/15 text-warning",
  approved: "bg-success/15 text-success",
  rejected: "bg-destructive/15 text-destructive",
};

export function ApprovalQueuePanel() {
  const { approvals, pendingApprovals, decideApproval, resetApproval } = useWorkshop();
  const canApprove = useCan("approve");
  const [filter, setFilter] = useState<ApprovalDecision | "all">("pending");
  const [openId, setOpenId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const visible = useMemo(
    () => (filter === "all" ? approvals : approvals.filter((a) => a.decision === filter)),
    [approvals, filter],
  );

  const counts = useMemo(
    () => ({
      approved: approvals.filter((a) => a.decision === "approved").length,
      rejected: approvals.filter((a) => a.decision === "rejected").length,
    }),
    [approvals],
  );

  function decide(item: ApprovalItem, decision: "approved" | "rejected") {
    if (!canApprove) {
      toast.error("Only a facilitator can approve or reject queue items");
      return;
    }
    if (decision === "rejected" && !notes[item.id]?.trim()) {
      setOpenId(item.id);
      toast.warning("Add a reason before rejecting");
      return;
    }
    decideApproval(item.id, decision, notes[item.id]);
    setNotes((prev) => ({ ...prev, [item.id]: "" }));
    setOpenId(null);
    toast.success(`${item.type} "${item.label}" ${decision}`, {
      action: { label: "Undo", onClick: () => resetApproval(item.id) },
    });
  }

  function approveAll() {
    const pending = approvals.filter((a) => a.decision === "pending");
    if (!canApprove || pending.length === 0) return;
    pending.forEach((p) => decideApproval(p.id, "approved"));
    toast.success(`Approved ${pending.length} queue item${pending.length === 1 ? "" : "s"}`);
  }

  return (
    <section className="console-panel" data-build="live">
      <PanelHeading
        build="live"
        title="Pending Approvals"
        hint={
          canApprove
            ? `${pendingApprovals} awaiting you · ${counts.approved} approved · ${counts.rejected} rejected`
            : "Facilitator approval required"
        }
        action={
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-warning/15 px-2 py-0.5 font-mono text-[10px] text-warning">
              {pendingApprovals}
            </span>
            <ClipboardCheck className="size-4 text-accent" />
          </div>
        }
      />

      <div className="flex items-center gap-1 border-b border-border px-3 py-2">
        {filters.map((f) => {
          const n =
            f.key === "all"
              ? approvals.length
              : f.key === "pending"
                ? pendingApprovals
                : counts[f.key as "approved" | "rejected"];
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "rounded px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors",
                filter === f.key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-elevated hover:text-foreground",
              )}
            >
              {f.label} {n}
            </button>
          );
        })}
        {canApprove && pendingApprovals > 0 && (
          <Button variant="ghost" size="sm" className="ml-auto text-primary" onClick={approveAll}>
            Approve all
          </Button>
        )}
      </div>

      <div className="divide-y divide-border">
        {visible.length === 0 && (
          <p className="p-4 text-xs text-muted-foreground">
            {filter === "pending" ? "Queue is clear — nothing awaiting approval." : "No items in this state."}
          </p>
        )}

        {visible.map((q) => {
          const open = openId === q.id;
          return (
            <div key={q.id} className="p-3.5">
              <div className="flex items-start gap-3">
                <button
                  className="min-w-0 flex-1 text-left"
                  onClick={() => setOpenId(open ? null : q.id)}
                  aria-expanded={open}
                >
                  <div className="flex items-center gap-2">
                    <p className="label-caps">{q.type}</p>
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider",
                        decisionStyles[q.decision],
                      )}
                    >
                      {q.decision}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs font-medium">{q.label}</p>
                  <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                    {q.submittedBy} · {q.submittedAt} · {q.count} linked item{q.count === 1 ? "" : "s"}
                  </p>
                </button>
                <ChevronDown
                  className={cn("mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
                />
              </div>

              {open && (
                <div className="mt-3 space-y-3 rounded-md border border-border bg-elevated/60 p-3">
                  <p className="text-xs leading-relaxed text-muted-foreground">{q.summary}</p>
                  <div>
                    <p className="label-caps">Supporting artifacts</p>
                    <ul className="mt-1 space-y-1">
                      {q.evidence.map((e) => (
                        <li key={e} className="text-[11px] text-muted-foreground">
                          · {e}
                        </li>
                      ))}
                    </ul>
                  </div>

                  {q.decision === "pending" ? (
                    <>
                      <Textarea
                        rows={2}
                        placeholder={canApprove ? "Decision note (required to reject)" : "Facilitator access required"}
                        disabled={!canApprove}
                        value={notes[q.id] ?? ""}
                        onChange={(e) => setNotes((prev) => ({ ...prev, [q.id]: e.target.value }))}
                        className="text-xs"
                      />
                      <div className="flex gap-2">
                        <Button size="sm" disabled={!canApprove} onClick={() => decide(q, "approved")}>
                          <CheckCircle2 className="size-3.5" /> Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={!canApprove}
                          onClick={() => decide(q, "rejected")}
                        >
                          <XCircle className="size-3.5" /> Reject
                        </Button>
                      </div>
                    </>
                  ) : (
                    <div className="space-y-2">
                      <p className="font-mono text-[10px] text-muted-foreground">
                        {q.decision === "approved" ? "Approved" : "Rejected"} by {q.decidedBy} · {q.decidedAt}
                      </p>
                      {q.note && <p className="text-[11px] italic text-muted-foreground">“{q.note}”</p>}
                      {canApprove && (
                        <Button variant="ghost" size="sm" onClick={() => resetApproval(q.id)}>
                          <RotateCcw className="size-3.5" /> Return to queue
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
