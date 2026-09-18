import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown, ChevronUp, Download, Eye, FileText, Loader2,
  Lock, Pencil, Plus, Printer, Send, Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PanelHeading } from "@/components/workshop-ui";
import { cn } from "@/lib/utils";
import { ReportSectionView } from "./ReportSectionView";
import { usePrintTheme } from "@/lib/use-print-theme";
import {
  canReview as roleCanReview,
  reportsApi,
  type MethodologyStage,
  type ReportDetail,
  type ReportSection,
  type WorkshopDetail,
} from "@/lib/api";

// The Report Builder (wireframe §8, App Spec §6.13 / §14.13).
//
// Every section comes from methodology configuration, so this file names no
// methodology concept: a "SWOT matrix" is whatever a category_matrix section
// resolves to, and a methodology with six categories gets six groups from the
// same code.
//
// Printing to PDF reuses the theme system the app already has: the report is
// rendered on screen, `beforeprint` swaps to the existing light palette, and
// the browser's own engine does the HTML-to-PDF conversion. That keeps text
// selectable and vector, with no extra dependency.

export function ReportBuilder({
  workshop,
  stage,
}: {
  workshop: WorkshopDetail;
  stage: MethodologyStage;
}) {
  // Printing swaps to the app's existing light palette; see the hook.
  usePrintTheme();

  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);

  const contributor = workshop.my_role === "facilitator" || workshop.my_role === "analyst";
  const reviewer = roleCanReview(workshop.my_role);
  // Publishing makes a report an organizational record — facilitators only.
  const publisher = workshop.my_role === "facilitator";

  const typesQuery = useQuery({
    queryKey: ["report-types", workshop.id],
    queryFn: () => reportsApi.types(workshop.id),
  });
  const listQuery = useQuery({
    queryKey: ["reports", workshop.id],
    queryFn: () => reportsApi.list(workshop.id),
  });

  // Default to the newest report once the list loads.
  useEffect(() => {
    if (!activeId && listQuery.data && listQuery.data.length > 0) {
      setActiveId(listQuery.data[0]!.id);
    }
  }, [listQuery.data, activeId]);

  const detailQuery = useQuery({
    queryKey: ["report", workshop.id, activeId],
    queryFn: () => reportsApi.get(workshop.id, activeId!),
    enabled: Boolean(activeId),
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["reports", workshop.id] });
    queryClient.invalidateQueries({ queryKey: ["report", workshop.id] });
  }

  const create = useMutation({
    mutationFn: (reportType: string) => reportsApi.create(workshop.id, { report_type: reportType }),
    onSuccess: (d) => {
      setActiveId(d.id);
      invalidate();
      toast.success("Report created");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveSections = useMutation({
    mutationFn: (sections: { id: string; sort_order: number; included: boolean }[]) =>
      reportsApi.updateSections(workshop.id, activeId!, sections),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(e.message),
  });

  const saveSection = useMutation({
    mutationFn: (v: { id: string; body: string }) =>
      reportsApi.updateSection(workshop.id, activeId!, v.id, v.body),
    onSuccess: () => {
      setEditingSection(null);
      invalidate();
      toast.success("Section saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const review = useMutation({
    mutationFn: (action: "submit" | "approve" | "reject") =>
      reportsApi.review(workshop.id, activeId!, action === "reject"
        ? { action, note: "Returned for revision" }
        : { action }),
    onSuccess: (d) => {
      invalidate();
      toast.success(`Report ${d.state}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const publish = useMutation({
    mutationFn: () => reportsApi.publish(workshop.id, activeId!),
    onSuccess: (d) => {
      invalidate();
      toast.success(`Published ${d.version}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const newVersion = useMutation({
    mutationFn: () => reportsApi.newVersion(workshop.id, activeId!, "minor"),
    onSuccess: (d) => {
      setActiveId(d.id);
      invalidate();
      toast.success(`Created ${d.version}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const report = detailQuery.data;
  const frozen = report?.state === "published" || report?.state === "archived";

  function move(section: ReportSection, direction: -1 | 1) {
    if (!report) return;
    const ordered = [...report.sections].sort((a, b) => a.sort_order - b.sort_order);
    const i = ordered.findIndex((s) => s.id === section.id);
    const j = i + direction;
    if (j < 0 || j >= ordered.length) return;
    const a = ordered[i]!;
    const b = ordered[j]!;
    saveSections.mutate([
      { id: a.id, sort_order: b.sort_order, included: a.included },
      { id: b.id, sort_order: a.sort_order, included: b.included },
    ]);
  }

  if (listQuery.isLoading || typesQuery.isLoading) {
    return (
      <section className="console-panel p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading reports…
        </div>
      </section>
    );
  }

  // Empty state (wireframe §8.32).
  if ((listQuery.data ?? []).length === 0) {
    return (
      <section className="console-panel" data-build="live">
        <PanelHeading build="live" title="Reports" hint="none yet" />
        <div className="space-y-3 p-4">
          <p className="text-sm text-muted-foreground">
            No report has been created. Choose a report type to begin.
          </p>
          {(typesQuery.data ?? []).map((t) => (
            <div key={t.key} className="rounded-md border border-border p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t.name}</p>
                  {t.description && (
                    <p className="mt-1 text-xs text-muted-foreground">{t.description}</p>
                  )}
                  <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">
                    {t.section_count} sections
                  </p>
                  {!t.can_generate && (
                    <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
                      Needs {t.missing.join(", ")} first.
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  disabled={!t.can_generate || !contributor || create.isPending}
                  onClick={() => create.mutate(t.key)}
                >
                  {create.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                  Create
                </Button>
              </div>
            </div>
          ))}
          {!contributor && (
            <p className="text-xs text-muted-foreground">
              Only a facilitator or analyst can create a report.
            </p>
          )}
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      {/* Report header — wireframe §8.8. Hidden when printing. */}
      <section className="console-panel print:hidden" data-build="live">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={activeId ?? ""}
              onChange={(e) => setActiveId(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-xs"
              aria-label="Select report"
            >
              {(listQuery.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title} · {r.version} · {r.state}
                </option>
              ))}
            </select>
            {report && (
              <span
                className={cn(
                  "rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
                  report.state === "published"
                    ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                    : "border-border text-muted-foreground",
                )}
              >
                {report.state}
              </span>
            )}
            {frozen && (
              <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                <Lock className="size-3" /> frozen at publication
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setPreview((p) => !p)}>
              <Eye className="size-3.5" />
              {preview ? "Edit mode" : "Preview"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => window.print()}>
              <Printer className="size-3.5" />
              Download PDF
            </Button>
            {report && (
              <Button asChild size="sm" variant="outline">
                <a href={reportsApi.exportHtmlUrl(workshop.id, report.id)} download>
                  <Download className="size-3.5" />
                  HTML
                </a>
              </Button>
            )}
          </div>
        </div>

        {/* Lifecycle controls (§8.30). */}
        <div className="flex flex-wrap items-center gap-1.5 px-4 py-2.5">
          {report?.state === "draft" && contributor && (
            <Button size="sm" variant="outline" onClick={() => review.mutate("submit")} disabled={review.isPending}>
              <Send className="size-3.5" />
              Submit for review
            </Button>
          )}
          {report?.state === "submitted" && reviewer && (
            <>
              <Button size="sm" variant="outline" onClick={() => review.mutate("approve")} disabled={review.isPending}>
                Approve
              </Button>
              <Button size="sm" variant="ghost" onClick={() => review.mutate("reject")} disabled={review.isPending}>
                Return for revision
              </Button>
            </>
          )}
          {report?.state === "approved" && publisher && (
            <Button size="sm" onClick={() => publish.mutate()} disabled={publish.isPending}>
              {publish.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <FileText className="size-3.5" />}
              Publish
            </Button>
          )}
          {report?.state === "approved" && !publisher && (
            <p className="text-xs text-muted-foreground">Only a facilitator can publish a report.</p>
          )}
          {frozen && contributor && (
            <Button size="sm" variant="outline" onClick={() => newVersion.mutate()} disabled={newVersion.isPending}>
              {newVersion.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              New version
            </Button>
          )}
          {report?.review_note && (
            <p className="text-xs italic text-muted-foreground">Reviewer: {report.review_note}</p>
          )}
        </div>
      </section>

      {detailQuery.isLoading && (
        <section className="console-panel p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading report…
          </div>
        </section>
      )}

      {report && (
        <ReportDocument
          report={report}
          preview={preview}
          frozen={Boolean(frozen)}
          contributor={contributor}
          editingSection={editingSection}
          onStartEdit={setEditingSection}
          onCancelEdit={() => setEditingSection(null)}
          onSaveSection={(id, body) => saveSection.mutate({ id, body })}
          onToggleInclude={(s) =>
            saveSections.mutate([{ id: s.id, sort_order: s.sort_order, included: !s.included }])
          }
          onMove={move}
          isSaving={saveSection.isPending || saveSections.isPending}
        />
      )}
    </div>
  );
}

function ReportDocument({
  report,
  preview,
  frozen,
  contributor,
  editingSection,
  onStartEdit,
  onCancelEdit,
  onSaveSection,
  onToggleInclude,
  onMove,
  isSaving,
}: {
  report: ReportDetail;
  preview: boolean;
  frozen: boolean;
  contributor: boolean;
  editingSection: string | null;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSaveSection: (id: string, body: string) => void;
  onToggleInclude: (s: ReportSection) => void;
  onMove: (s: ReportSection, dir: -1 | 1) => void;
  isSaving: boolean;
}) {
  const ordered = [...report.sections].sort((a, b) => a.sort_order - b.sort_order);
  const visible = preview ? ordered.filter((s) => s.included) : ordered;

  return (
    <section className="console-panel report-document" data-build="live">
      {/* Cover — the first printed page. */}
      <header className="report-cover border-b border-border px-5 py-6">
        <h1 className="text-2xl font-semibold">{report.title}</h1>
        <p className="mt-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          {report.version} · {report.state}
          {report.published_at && ` · published ${new Date(report.published_at).toLocaleDateString()}`}
        </p>
        {report.from_snapshot && (
          <p className="mt-2 text-xs text-muted-foreground">
            This is the published version. Its content was frozen when it was published, so later changes
            to the workshop do not alter it.
          </p>
        )}
      </header>

      {/* Contents. Page numbers are deliberately absent — browser print
          cannot resolve them reliably, so linked section names are honest. */}
      <nav className="border-b border-border px-5 py-3.5">
        <p className="label-caps">Contents</p>
        <ol className="mt-1.5 space-y-0.5">
          {ordered.filter((s) => s.included).map((s, i) => (
            <li key={s.id} className="text-xs text-muted-foreground">
              {i + 1}. {s.name}
            </li>
          ))}
        </ol>
      </nav>

      <div className="divide-y divide-border">
        {visible.map((s) => (
          <ReportSectionView
            key={s.id}
            section={s}
            preview={preview}
            frozen={frozen}
            contributor={contributor}
            editing={editingSection === s.id}
            onStartEdit={() => onStartEdit(s.id)}
            onCancelEdit={onCancelEdit}
            onSave={(body) => onSaveSection(s.id, body)}
            onToggleInclude={() => onToggleInclude(s)}
            onMoveUp={() => onMove(s, -1)}
            onMoveDown={() => onMove(s, 1)}
            isSaving={isSaving}
          />
        ))}
      </div>
    </section>
  );
}

// Small controls shared by the section view, kept here so the view file stays
// about rendering content.
export function SectionControls({
  section,
  onToggleInclude,
  onMoveUp,
  onMoveDown,
  onStartEdit,
  canEditBody,
}: {
  section: ReportSection;
  onToggleInclude: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onStartEdit: () => void;
  canEditBody: boolean;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 print:hidden">
      {canEditBody && (
        <Button size="icon" variant="ghost" className="size-7" onClick={onStartEdit} aria-label="Edit section">
          <Pencil className="size-3.5" />
        </Button>
      )}
      <Button size="icon" variant="ghost" className="size-7" onClick={onMoveUp} aria-label="Move section up">
        <ChevronUp className="size-3.5" />
      </Button>
      <Button size="icon" variant="ghost" className="size-7" onClick={onMoveDown} aria-label="Move section down">
        <ChevronDown className="size-3.5" />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="text-[10px] uppercase tracking-wider"
        onClick={onToggleInclude}
      >
        {section.included ? "Exclude" : "Include"}
      </Button>
    </div>
  );
}
