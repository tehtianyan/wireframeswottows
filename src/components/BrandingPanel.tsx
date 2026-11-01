// The branding panel — /admin, platform administrators only.
//
// This is the whole maintenance surface for white labelling: adding a client,
// or changing one's logo, is this panel and nothing else. No deploy, no
// migration, no code. That was the design requirement, so the panel has to
// carry everything an administrator needs to get it right FIRST time.
//
// THE DUAL PREVIEW IS LOAD-BEARING, NOT DECORATION. A JPEG has no alpha
// channel, so a client logo delivered as JPEG renders its own white rectangle
// in the dark header — the single most common failure here. Without a preview
// the only way to discover that is to save it and go looking, by which point
// it is on the client's exported reports. Showing both modes and the print
// cover side by side means it is seen before it is stored.

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImageUp, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { adminApi, type AdminOrganization } from "@/lib/api";
import { BUILD_BRAND, resolveBrand, type OrgBranding } from "@/lib/brand";
import { PanelHeading } from "@/components/workshop-ui";

/** Mirrors the Go cap and the column's CHECK. Checked here too so an obvious
 *  mistake is caught before a 256KB round trip, never INSTEAD of there. */
const MAX_DATA_URI = 262144;

export function BrandingPanel() {
  const queryClient = useQueryClient();
  const [orgId, setOrgId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [logo, setLogo] = useState<string | null>(null);
  const [logoName, setLogoName] = useState("");
  const [dirty, setDirty] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const orgsQuery = useQuery({
    queryKey: ["admin-organizations"],
    queryFn: () => adminApi.organizations(),
    retry: false,
  });

  const orgs = orgsQuery.data ?? [];
  const selected: AdminOrganization | undefined =
    orgs.find((o) => o.organization_id === orgId) ?? orgs[0];

  // Load the selected organization's stored values into the form. Keyed on
  // the id so switching organizations discards an unsaved edit rather than
  // carrying one client's name onto another's record.
  useEffect(() => {
    if (!selected) return;
    setDisplayName(selected.display_name);
    setLogo(selected.logo_data_uri || null);
    setLogoName(selected.logo_filename);
    setDirty(false);
  }, [selected?.organization_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error("No organization selected.");
      return adminApi.setBranding(selected.organization_id, {
        display_name: displayName.trim() === "" ? null : displayName.trim(),
        logo_data_uri: logo,
        logo_filename: logo ? logoName || null : null,
      });
    },
    onSuccess: (saved: OrgBranding) => {
      // Both keys: the admin list AND the live brand, so the header repaints
      // without a reload. Forgetting the second is how an administrator comes
      // to believe the save failed.
      queryClient.invalidateQueries({ queryKey: ["admin-organizations"] });
      queryClient.invalidateQueries({ queryKey: ["branding"] });
      setDirty(false);
      toast.success(`Branding saved for ${saved.name}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function onPick(file: File | undefined) {
    if (!file) return;
    // Named here rather than left to the server, because the server's answer
    // costs a round trip and this one is instant and certain.
    if (/svg/i.test(file.type) || /\.svg$/i.test(file.name)) {
      toast.error(
        "SVG logos are not accepted — an SVG can contain scripts, and this file is shown to everyone in the organization and embedded in exported reports. Please use a PNG with transparency.",
      );
      return;
    }
    if (!/^image\/(png|jpeg)$/i.test(file.type)) {
      toast.error("Please choose a PNG or JPEG file.");
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => toast.error("That file could not be read. Try choosing it again.");
    reader.onload = () => {
      const uri = typeof reader.result === "string" ? reader.result : "";
      if (uri.length > MAX_DATA_URI) {
        toast.error(
          `That image is ${Math.round(uri.length / 1024)} KB encoded — the limit is ${MAX_DATA_URI / 1024} KB. Export it at about 80px tall and try again.`,
        );
        return;
      }
      setLogo(uri);
      setLogoName(file.name);
      setDirty(true);
    };
    reader.readAsDataURL(file);
  }

  if (orgsQuery.isLoading) {
    return (
      <section className="console-panel p-6" data-build="live">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </section>
    );
  }

  // The panel sits inside the admin page, which has already established the
  // caller is an administrator — so a failure here is something else, and the
  // server's own sentence is more useful than a guess.
  if (orgsQuery.isError) {
    return (
      <section className="console-panel p-6" data-build="live">
        <PanelHeading build="live" title="Branding" />
        <p className="mt-2 text-sm text-muted-foreground">
          {orgsQuery.error instanceof Error
            ? orgsQuery.error.message
            : "Branding could not be loaded."}
        </p>
      </section>
    );
  }

  if (orgs.length === 0) {
    return (
      <section className="console-panel p-6" data-build="live">
        <PanelHeading build="live" title="Branding" />
        <p className="mt-2 text-sm text-muted-foreground">
          There are no active organizations to brand yet.
        </p>
      </section>
    );
  }

  // The preview renders through resolveBrand — the SAME function the live
  // header uses. A preview computing its own answer would be worse than none:
  // it would be confidently wrong.
  const preview = resolveBrand({
    organization_id: selected?.organization_id ?? "preview",
    name: selected?.name ?? "",
    display_name: displayName,
    logo_data_uri: logo ?? "",
    logo_filename: logoName,
  });

  return (
    <section className="console-panel" data-build="live">
      <PanelHeading
        build="live"
        title="Branding"
        hint={`${orgs.length} organization${orgs.length === 1 ? "" : "s"}`}
        action={
          <div className="flex items-center gap-2">
            {dirty && <span className="text-[11px] text-warning">Unsaved</span>}
            <Button
              size="sm"
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending && <Loader2 className="size-3.5 animate-spin" />}
              Save branding
            </Button>
          </div>
        }
      />

      <div className="grid gap-5 p-4 lg:grid-cols-2">
        <div className="space-y-4">
          <label className="block">
            <span className="text-xs font-medium text-muted-foreground">Organization</span>
            <select
              className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              value={selected?.organization_id ?? ""}
              onChange={(e) => setOrgId(e.target.value)}
            >
              {orgs.map((o) => (
                <option key={o.organization_id} value={o.organization_id}>
                  {o.name}
                  {o.workspace_count > 0 ? ` · ${o.workspace_count} workspace${o.workspace_count === 1 ? "" : "s"}` : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-medium text-muted-foreground">Display name</span>
            <Input
              className="mt-1"
              value={displayName}
              maxLength={120}
              placeholder={selected?.name ?? BUILD_BRAND.name}
              onChange={(e) => {
                setDisplayName(e.target.value);
                setDirty(true);
              }}
            />
            <span className="mt-1 block text-[11px] text-muted-foreground">
              Shown in the header and on the browser tab. Leave empty to use{" "}
              {selected?.name ? `"${selected.name}"` : "the organization's own name"}.
            </span>
          </label>

          <div>
            <span className="text-xs font-medium text-muted-foreground">Logo</span>
            <div className="mt-1 flex items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg"
                className="hidden"
                onChange={(e) => {
                  onPick(e.target.files?.[0]);
                  // Cleared so re-choosing the same file fires onChange again.
                  e.target.value = "";
                }}
              />
              <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
                <ImageUp className="size-3.5" />
                Choose file…
              </Button>
              {logo && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setLogo(null);
                    setLogoName("");
                    setDirty(true);
                  }}
                >
                  <Trash2 className="size-3.5" />
                  Remove
                </Button>
              )}
            </div>
            <span className="mt-1.5 block text-[11px] leading-relaxed text-muted-foreground">
              PNG or JPEG, up to {MAX_DATA_URI / 1024} KB. About 240×80 (or 480×160 for sharp
              retina rendering) suits the header.{" "}
              <strong className="text-foreground">Prefer a PNG with transparency</strong> — a
              JPEG carries its own white background, which shows as a pale box in the dark
              header. Check both previews below before saving. SVG is not accepted because it
              can carry scripts.
            </span>
            {logoName && (
              <span className="mt-1 block text-[11px] text-muted-foreground">
                Loaded: {logoName}
                {logo ? ` · ${Math.round(logo.length / 1024)} KB encoded` : ""}
              </span>
            )}
          </div>

          {(selected?.display_name || selected?.logo_data_uri) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDisplayName("");
                setLogo(null);
                setLogoName("");
                setDirty(true);
              }}
            >
              <RotateCcw className="size-3.5" />
              Reset to default branding
            </Button>
          )}
        </div>

        {/* Both modes, side by side, plus the print cover. These are the three
            places the mark actually lands. */}
        <div className="space-y-3">
          <span className="text-xs font-medium text-muted-foreground">Preview</span>

          <div className="grid gap-3 sm:grid-cols-2">
            <PreviewHeader mode="dark" brandName={preview.shortName} logoUrl={preview.logoUrl} initials={preview.initials} />
            <PreviewHeader mode="light" brandName={preview.shortName} logoUrl={preview.logoUrl} initials={preview.initials} />
          </div>

          <div className="rounded-md border border-border bg-white p-4 text-[#1a1a1a]">
            <div className="flex items-start justify-between gap-3 border-b-2 border-[#1a1a1a] pb-2">
              <div>
                <div className="font-serif text-base leading-tight">Strategic Assessment</div>
                <div className="mt-0.5 font-mono text-[9px] uppercase tracking-wider text-[#555]">
                  {selected?.name ?? "Client"} · v1 · published
                </div>
              </div>
              {preview.logoUrl && (
                <img src={preview.logoUrl} alt="" className="h-8 w-auto max-w-[120px] object-contain" />
              )}
            </div>
            <p className="mt-2 text-[10px] text-[#555]">
              Exported report cover. The logo is embedded in the file itself, so an archived
              report keeps the branding it was published with.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/** A miniature of the real header, forced to one mode regardless of the
 *  administrator's own theme — the point is to see the mode you are NOT in. */
function PreviewHeader({
  mode,
  brandName,
  logoUrl,
  initials,
}: {
  mode: "dark" | "light";
  brandName: string;
  logoUrl: string | null;
  initials: string;
}) {
  const dark = mode === "dark";
  return (
    <div
      className="rounded-md border p-3"
      style={{
        // Literal colours, deliberately: this must show the DARK header while
        // the administrator sits in light mode, so it cannot read tokens from
        // the current theme.
        background: dark ? "oklch(0.19 0.026 258)" : "oklch(0.97 0.006 250)",
        borderColor: dark ? "oklch(0.3 0.02 258)" : "oklch(0.88 0.006 250)",
      }}
    >
      <div className="flex items-center gap-2">
        {logoUrl ? (
          <img src={logoUrl} alt="" className="h-7 w-auto max-w-[120px] object-contain" />
        ) : (
          <span
            className="grid size-7 place-items-center rounded-md text-[11px] font-bold"
            style={{
              background: dark ? "oklch(0.76 0.13 196)" : "oklch(0.55 0.12 214)",
              color: dark ? "oklch(0.19 0.026 258)" : "oklch(0.99 0 0)",
            }}
          >
            {initials}
          </span>
        )}
        {!logoUrl && (
          <span
            className="text-xs font-semibold"
            style={{ color: dark ? "oklch(0.95 0.004 250)" : "oklch(0.25 0.02 258)" }}
          >
            {brandName}
          </span>
        )}
      </div>
      <span
        className="mt-2 block text-[10px] uppercase tracking-wider"
        style={{ color: dark ? "oklch(0.7 0.01 250)" : "oklch(0.5 0.01 250)" }}
      >
        {dark ? "Night" : "Day"}
      </span>
    </div>
  );
}
