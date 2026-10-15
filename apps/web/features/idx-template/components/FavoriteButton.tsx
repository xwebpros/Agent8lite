"use client";
import { Heart } from "lucide-react";
import { useTemplateSite } from "../context";
export function FavoriteButton({ listingKey }: { listingKey: string }) {
  const site = useTemplateSite();
  return (
    <button
      type="button"
      disabled
      title="Native visitor favorites are unavailable in this template release."
      aria-label={`Save property ${listingKey}: unavailable`}
      aria-pressed={false}
      className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-border bg-background/95 text-foreground shadow-sm transition hover:bg-background focus:outline-none focus:ring-2 focus:ring-primary"
    >
      <Heart className="h-5 w-5" />
      <span className="sr-only">
        {site.capabilities.favorites
          ? "Visitor sign-in required; unavailable in this release"
          : "Favorites unavailable"}
      </span>
    </button>
  );
}
