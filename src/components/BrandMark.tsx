// The brand mark: a logo image when one is set, the initials tile when not.
//
// THE SIZING IS THE POINT. The tile this replaces was a 32px rounded SQUARE
// filled with --primary, which is right for two letters and wrong for every
// real logo: a wordmark is wider than tall, and a raster image carries its
// own background, so painting --primary behind it produces a coloured band
// around the logo instead of a tinted mark. The image therefore gets a FIXED
// HEIGHT and free width, object-contain, and NO background fill.
//
// A JPEG has no alpha channel, so a client logo supplied as JPEG shows its own
// white rectangle in the dark header. Nothing here can fix that — the admin
// panel previews both modes so it is seen before it is saved, rather than
// discovered on the client's report.

import { useQuery } from "@tanstack/react-query";
import { brandingApi } from "@/lib/api";
import { BUILD_BRAND, resolveBrand, type Brand } from "@/lib/brand";
import { cn } from "@/lib/utils";

/**
 * The brand in force for this session.
 *
 * Falls back to the deployment brand on every unhappy path — no session, no
 * organization, membership of several organizations, or a failed request.
 * That matters because one of those paths is hit on literally every first
 * paint, so the fallback is the normal case rather than an error case.
 */
export function useBrand(): Brand {
  const { data } = useQuery({
    queryKey: ["branding"],
    queryFn: () => brandingApi.mine(),
    // The brand does not change within a session unless an administrator
    // changes it, and that invalidates this key explicitly.
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  return resolveBrand(data);
}

export function BrandMark({
  brand,
  className,
  /** Height of the mark in Tailwind units; the header uses 8 (32px). */
  size = 8,
}: {
  brand?: Brand;
  className?: string;
  size?: 6 | 8 | 10;
}) {
  const b = brand ?? BUILD_BRAND;
  const heights = { 6: "h-6", 8: "h-8", 10: "h-10" } as const;
  const tiles = { 6: "size-6 text-xs", 8: "size-8 text-sm", 10: "size-10 text-base" } as const;

  if (b.logoUrl) {
    return (
      <img
        src={b.logoUrl}
        alt={b.logoAlt}
        className={cn(heights[size], "w-auto max-w-[160px] object-contain", className)}
      />
    );
  }

  return (
    <span
      className={cn(
        "grid place-items-center rounded-md bg-primary font-display font-bold text-primary-foreground",
        tiles[size],
        className,
      )}
      // Decorative here: the wordmark beside it already carries the name, so
      // announcing the initials too would read it out twice.
      aria-hidden="true"
    >
      {b.initials || BUILD_BRAND.initials}
    </span>
  );
}
