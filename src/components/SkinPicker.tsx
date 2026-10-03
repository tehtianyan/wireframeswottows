import { Check, Palette } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useUiPrefs } from "@/lib/ui-prefs";
import { SKINS, skinByKey } from "@/lib/skins";

// The skin picker, beside the day/night toggle.
//
// Two SEPARATE controls on purpose. A skin is which palette the workshop is
// branded in; the toggle is whether you are in a lit room or a dark one. Rolling
// them into one menu of ten entries would force a choice between them, and a
// facilitator who dims the room mid-session should not have to re-pick their
// client's colours.
//
// The swatches preview each skin in the mode you are CURRENTLY in, so what you
// see in the menu is what you get on the page.

export function SkinPicker() {
  const { skin, setSkin, theme } = useUiPrefs();
  const active = skinByKey(skin);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          aria-label={`Change skin — currently ${active.name}`}
          title={`Skin: ${active.name}`}
        >
          <Palette className="size-4" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="font-normal text-muted-foreground">
          Skin
          <span className="mt-0.5 block text-[11px] leading-snug">
            Day and dark mode both work in every skin, and the toggle beside this one keeps
            working as it does now.
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {SKINS.map((s) => {
          const swatch = theme === "light" ? s.swatchLight : s.swatchDark;
          const selected = s.key === skin;
          return (
            <DropdownMenuItem
              key={s.key}
              onClick={() => setSkin(s.key)}
              className="items-start gap-2.5 py-2"
            >
              {/* Three chips: surface, primary, accent — enough to recognise a
                  palette without pretending to be a full preview. */}
              <span
                aria-hidden
                className="mt-0.5 flex shrink-0 overflow-hidden rounded border border-border-strong"
              >
                {swatch.map((c, i) => (
                  <span key={i} className="size-3.5" style={{ background: c }} />
                ))}
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className={cn("text-xs", selected && "font-semibold")}>{s.name}</span>
                  {selected && <Check className="size-3 text-primary" />}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                  {s.description}
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
