import { Sparkles } from "lucide-react";

// Renders a `narrative` AI output — a challenge, an explanation, a workshop
// summary, an executive summary, a prioritization review.
//
// WHY THIS EXISTS: the AI panel could only render an ARRAY of titled
// suggestions. Every narrative function returns a single nested object instead,
// so the panel found no array and said "The assistant had nothing to add" —
// after a real, paid model call that had in fact produced a full answer. Four
// of the assistant's functions looked broken for that reason alone.
//
// It is deliberately SHAPE-DRIVEN, not schema-driven: it walks whatever keys
// the configured output schema declares and renders strings as paragraphs and
// string arrays as lists. So a methodology that adds a narrative function with
// different keys gets a sensible panel with no code change — which is the same
// bargain the rest of the engine makes.

/** "missing_evidence" -> "Missing evidence". Keys are the schema's own. */
function humanise(key: string): string {
  const words = key.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function AiNarrativeView({
  narrative,
  emptyNote = "The assistant found nothing to report here.",
}: {
  narrative: Record<string, unknown>;
  emptyNote?: string;
}) {
  const sections = Object.entries(narrative).filter(([, v]) => {
    if (typeof v === "string") return v.trim() !== "";
    if (Array.isArray(v)) return v.some((x) => String(x ?? "").trim() !== "");
    return v !== null && v !== undefined && typeof v === "object";
  });

  if (sections.length === 0) {
    return <p className="px-3.5 py-3 text-xs text-muted-foreground">{emptyNote}</p>;
  }

  return (
    <div className="space-y-3 px-3.5 py-3">
      <span className="inline-flex items-center gap-1 rounded border border-violet-500/40 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-violet-600 dark:text-violet-400">
        <Sparkles className="size-2.5" />
        AI generated
      </span>

      {sections.map(([key, value]) => (
        <section key={key}>
          <p className="label-caps">{humanise(key)}</p>
          <NarrativeValue value={value} />
        </section>
      ))}

      <p className="border-t border-border pt-2 text-[11px] leading-relaxed text-muted-foreground">
        This is the assistant's reading of the workshop's own data. It changes nothing and
        approves nothing — it is here to be argued with.
      </p>
    </div>
  );
}

function NarrativeValue({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{value}</p>;
  }

  if (Array.isArray(value)) {
    const items = value.map((x) => String(x ?? "").trim()).filter((x) => x !== "");
    if (items.length === 0) {
      // Said explicitly rather than skipped: "no anomalies" is a finding, and a
      // section that silently disappears looks like the model forgot to answer.
      return <p className="mt-0.5 text-xs italic text-muted-foreground">Nothing to report.</p>;
    }
    return (
      <ul className="mt-1 space-y-1">
        {items.map((item, i) => (
          <li key={i} className="flex gap-1.5 text-xs leading-relaxed text-muted-foreground">
            <span aria-hidden className="select-none">
              ·
            </span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    );
  }

  // A nested object — an executive summary's sub-sections, for instance.
  if (value !== null && typeof value === "object") {
    return (
      <div className="mt-1 space-y-2 border-l-2 border-border pl-2.5">
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <div key={k}>
            <p className="label-caps">{humanise(k)}</p>
            <NarrativeValue value={v} />
          </div>
        ))}
      </div>
    );
  }

  return null;
}
