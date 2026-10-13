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
      className="rounded-full bg-background/95 p-2 text-muted-foreground shadow-sm"
    >
      <Heart className="size-5" />
      <span className="sr-only">
        {site.capabilities.favorites
          ? "Visitor sign-in required; unavailable in this release"
          : "Favorites unavailable"}
      </span>
    </button>
  );
}
