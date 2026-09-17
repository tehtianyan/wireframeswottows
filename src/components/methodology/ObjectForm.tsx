import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { CitableItem } from "./useStageObjects";
import type { CitableKind, ObjectKind, WorkObject, WriteObjectInput } from "@/lib/api";

// Create/edit form for any analysis object. Every input is generated from the
// kind's field definitions and the stage's declared citations — there is no
// per-kind form anywhere in the app.

const KIND_LABELS: Record<CitableKind, string> = {
  factor: "factors",
  synthesis: "themes",
  factor_relationship: "relationships",
  insight: "insights",
};

export function ObjectForm({
  kind,
  cites,
  pools,
  initial,
  onSubmit,
  onCancel,
  isPending,
}: {
  kind: ObjectKind;
  cites: CitableKind[];
  pools: Map<CitableKind, CitableItem[]>;
  initial?: WorkObject;
  onSubmit: (input: WriteObjectInput) => void;
  onCancel?: () => void;
  isPending: boolean;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [fields, setFields] = useState<Record<string, unknown>>(() => {
    const f: Record<string, unknown> = {};
    for (const def of kind.fields) {
      const v = initial?.fields[def.name];
      f[def.name] = v === null || v === undefined ? (def.type === "enum" ? def.options?.[0] ?? "" : "") : v;
    }
    return f;
  });
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(Object.values(initial?.evidence ?? {}).flatMap((ids) => ids ?? [])),
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();

    // Group the flat selection back into the per-kind shape the API expects.
    const evidence: Partial<Record<CitableKind, string[]>> = {};
    for (const citeKind of cites) {
      evidence[citeKind] = (pools.get(citeKind) ?? [])
        .filter((item) => selected.has(item.id))
        .map((item) => item.id);
    }

    const payload: WriteObjectInput = { evidence };
    if (kind.title_required || title.trim()) payload.title = title.trim();
    payload.description = description.trim() || null;

    const outFields: Record<string, unknown> = {};
    for (const def of kind.fields) {
      const raw = fields[def.name];
      if (def.type === "int") {
        const s = String(raw ?? "").trim();
        outFields[def.name] = s === "" ? null : Number(s);
      } else {
        const s = String(raw ?? "").trim();
        outFields[def.name] = s === "" ? null : s;
      }
    }
    payload.fields = outFields;

    onSubmit(payload);
  }

  const titleMissing = kind.title_required && !title.trim();
  const requiredFieldMissing = kind.fields.some(
    (f) => f.required && !String(fields[f.name] ?? "").trim(),
  );

  return (
    <form onSubmit={submit} className="space-y-3 border-b border-border bg-elevated/40 p-4">
      <div>
        <label className="label-caps" htmlFor="obj-title">
          Title{kind.title_required ? "" : " (optional)"}
        </label>
        <Input
          id="obj-title"
          className="mt-1.5"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          disabled={isPending}
        />
      </div>

      {kind.description_label && (
        <div>
          <label className="label-caps" htmlFor="obj-description">
            {kind.description_label}
          </label>
          <Textarea
            id="obj-description"
            className="mt-1.5"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={isPending}
          />
        </div>
      )}

      {kind.fields.map((f) => (
        <div key={f.name}>
          <label className="label-caps" htmlFor={`obj-${f.name}`}>
            {f.label}
            {f.required ? "" : " (optional)"}
          </label>
          {f.type === "enum" ? (
            <select
              id={`obj-${f.name}`}
              className="mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={String(fields[f.name] ?? "")}
              onChange={(e) => setFields((p) => ({ ...p, [f.name]: e.target.value }))}
              disabled={isPending}
            >
              {f.options?.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : f.type === "int" ? (
            <Input
              id={`obj-${f.name}`}
              className="mt-1.5"
              type="number"
              value={String(fields[f.name] ?? "")}
              onChange={(e) => setFields((p) => ({ ...p, [f.name]: e.target.value }))}
              disabled={isPending}
            />
          ) : (
            <Textarea
              id={`obj-${f.name}`}
              className="mt-1.5"
              rows={2}
              value={String(fields[f.name] ?? "")}
              onChange={(e) => setFields((p) => ({ ...p, [f.name]: e.target.value }))}
              disabled={isPending}
            />
          )}
          {f.help && <p className="mt-1 text-[11px] text-muted-foreground">{f.help}</p>}
        </div>
      ))}

      {cites.map((citeKind) => {
        const pool = pools.get(citeKind) ?? [];
        return (
          <div key={citeKind}>
            <label className="label-caps">
              Supporting {KIND_LABELS[citeKind]} ({pool.filter((p) => selected.has(p.id)).length} selected)
            </label>
            {pool.length === 0 ? (
              <p className="mt-1.5 text-xs text-muted-foreground">
                Nothing available to cite yet — complete the earlier stage first.
              </p>
            ) : (
              <div className="mt-1.5 max-h-52 space-y-1 overflow-y-auto rounded-md border border-border p-1.5">
                {pool.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => toggle(item.id)}
                    className={cn(
                      "flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors",
                      selected.has(item.id) ? "bg-foreground/10" : "hover:bg-elevated",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-sm border",
                        selected.has(item.id) ? "border-foreground bg-foreground text-background" : "border-border",
                      )}
                    >
                      {selected.has(item.id) && <Check className="size-2.5" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block font-medium">{item.label}</span>
                      {item.state !== "approved" && (
                        <span className="font-mono text-[10px] text-muted-foreground">{item.state}</span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div className="flex items-center justify-end gap-2">
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={isPending}>
            Cancel
          </Button>
        )}
        <Button type="submit" size="sm" disabled={isPending || titleMissing || requiredFieldMissing}>
          {isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          {initial ? "Save" : `Add ${kind.label.toLowerCase()}`}
        </Button>
      </div>
    </form>
  );
}
