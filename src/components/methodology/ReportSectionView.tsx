import { useState } from "react";
import { Check, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { SectionControls } from "./ReportBuilder";
import type { ReportSection } from "@/lib/api";

// Renders one report section. Which renderer runs is decided by
// section_type — a platform vocabulary, like stage_type — while WHAT it
// renders comes entirely from methodology config. No branch here knows what
// SWOT or TOWS is.

export function ReportSectionView({
  section,
  preview,
  frozen,
  contributor,
  editing,
  onStartEdit,
  onCancelEdit,
  onSave,
  onToggleInclude,
  onMoveUp,
  onMoveDown,
  isSaving,
}: {
  section: ReportSection;
  preview: boolean;
  frozen: boolean;
  contributor: boolean;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: (body: string) => void;
  onToggleInclude: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  isSaving: boolean;
}) {
  const [draft, setDraft] = useState(section.body ?? "");
  const editable = contributor && !frozen;
  const isNarrative = section.section_type === "narrative";

  return (
    <section
      className={cn(
        "report-section px-5 py-4",
        !section.included && !preview && "opacity-45",
      )}
      id={`section-${section.section_key}`}
    >
      <div className="mb-2.5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{section.name}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {section.section_type.replace("_", " ")}
            </span>
            {/* §14.13: AI-generated and human-edited content must be
                distinguishable. */}
            {section.generated_by !== "human" && (
              <span className="inline-flex items-center gap-1 rounded border border-violet-500/40 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-violet-600 dark:text-violet-400">
                <Sparkles className="size-2.5" />
                {section.generated_by === "hybrid" ? "AI draft, edited" : "AI generated"}
              </span>
            )}
            {!section.included && (
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                excluded
              </span>
            )}
          </div>
        </div>

        {editable && !preview && (
          <SectionControls
            section={section}
            onToggleInclude={onToggleInclude}
            onMoveUp={onMoveUp}
            onMoveDown={onMoveDown}
            onStartEdit={onStartEdit}
            canEditBody={isNarrative}
          />
        )}
      </div>

      {editing ? (
        <div className="space-y-2">
          <Textarea rows={6} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onCancelEdit}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => onSave(draft)} disabled={isSaving}>
              {isSaving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              Save
            </Button>
          </div>
        </div>
      ) : (
        <SectionBody section={section} />
      )}
    </section>
  );
}

function SectionBody({ section }: { section: ReportSection }) {
  switch (section.section_type) {
    case "narrative":
      return section.body ? (
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{section.body}</p>
      ) : (
        <p className="text-xs italic text-muted-foreground">
          Not yet written. Use the AI assistant to draft it, or write it yourself.
        </p>
      );

    case "table":
      return (section.items ?? []).length === 0 ? (
        <Empty />
      ) : (
        // §14.23 mandates these columns.
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="py-2 pr-3 font-medium">Recommendation</th>
                <th className="py-2 pr-3 font-medium">Priority</th>
                <th className="py-2 pr-3 font-medium">Expected benefit</th>
                <th className="py-2 font-medium">Risk</th>
              </tr>
            </thead>
            <tbody>
              {(section.items ?? []).map((it) => (
                <tr key={it.id} className="border-b border-border/60 align-top">
                  <td className="py-2 pr-3">
                    <span className="font-medium">{it.title}</span>
                    {it.body && <span className="block text-muted-foreground">{it.body}</span>}
                  </td>
                  <td className="py-2 pr-3">{String(it.fields?.["priority"] ?? "—")}</td>
                  <td className="py-2 pr-3 text-muted-foreground">
                    {String(it.fields?.["benefits"] ?? "—")}
                  </td>
                  <td className="py-2 text-muted-foreground">{String(it.fields?.["risks"] ?? "—")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case "evidence_chain":
      return (section.chains ?? []).length === 0 ? (
        <Empty />
      ) : (
        <div className="space-y-3">
          {(section.chains ?? []).map((ch) => (
            <div key={ch.root.id} className="border-l-2 border-border pl-3">
              <p className="text-sm font-medium">{ch.root.title}</p>
              {Object.entries(ch.supports).map(([kind, items]) => (
                <p key={kind} className="mt-1 text-xs text-muted-foreground">
                  <span className="label-caps">{kind.replace("_", " ")}</span>{" "}
                  {items.map((i) => i.title).join("; ")}
                </p>
              ))}
            </div>
          ))}
        </div>
      );

    case "category_matrix":
    case "pair_matrix":
    case "appendix":
      return (section.groups ?? []).length === 0 ? (
        <Empty note="This methodology defines nothing for this section." />
      ) : (
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))" }}
        >
          {(section.groups ?? []).map((g) => (
            <div
              key={g.key}
              className="rounded-md border border-border p-3"
              style={g.color_token ? ({ borderColor: `var(--${g.color_token})` } as React.CSSProperties) : undefined}
            >
              <p
                className="font-mono text-[10px] uppercase tracking-wider"
                style={g.color_token ? ({ color: `var(--${g.color_token})` } as React.CSSProperties) : undefined}
              >
                {g.name}
              </p>
              {g.source_name && (
                <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                  {g.source_name} × {g.target_name}
                </p>
              )}
              {g.items.length === 0 ? (
                <p className="mt-1.5 text-xs italic text-muted-foreground">None.</p>
              ) : (
                <ul className="mt-1.5 space-y-1">
                  {g.items.map((it) => (
                    <li key={it.id} className="text-xs">
                      <span className="font-medium">{it.title}</span>
                      {it.body && <span className="block text-muted-foreground">{it.body}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      );

    default: // bullet_list, object_list
      return (section.items ?? []).length === 0 ? (
        <Empty />
      ) : (
        <ul className="space-y-1.5">
          {(section.items ?? []).map((it) => (
            <li key={it.id} className="text-sm">
              <span className="font-medium">{it.title}</span>
              {it.body && <span className="block text-xs text-muted-foreground">{it.body}</span>}
            </li>
          ))}
        </ul>
      );
  }
}

function Empty({ note }: { note?: string }) {
  return (
    <p className="text-xs italic text-muted-foreground">
      {note ?? "Nothing approved to show here yet."}
    </p>
  );
}
