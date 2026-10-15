"use client";

import { Listing } from "../api";
import { Link } from "../navigation";
import { IdxAttribution } from "../components/IdxAttribution";

export function MapListingPreview({ listing }: { listing: Listing }) {
  const price = listing.price
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      }).format(listing.price)
    : "Price Upon Request";
  const location = [listing.streetAddress, listing.city, listing.state].filter(Boolean).join(", ");

  return (
    <div className="min-w-[210px] space-y-2">
      {listing.photos?.[0] && (
        <img
          src={listing.photos[0]}
          alt={location || "Property"}
          className="h-24 w-full rounded-md object-cover"
          loading="lazy"
        />
      )}
      <p className="text-base font-serif font-medium text-foreground">{price}</p>
      <p className="text-xs text-muted-foreground">{location || "Location unavailable"}</p>
      <p className="text-xs text-muted-foreground">
        {listing.bedrooms ?? "-"} beds · {listing.bathrooms ?? "-"} baths
        {listing.livingArea ? ` · ${listing.livingArea.toLocaleString()} sq ft` : ""}
      </p>
      <div className="mt-3 flex items-center justify-between gap-4 border-t border-border/60 pt-2">
        <IdxAttribution listing={listing} compact />
        <Link
          href={`/listing/${listing.listingKey}`}
          className="ml-auto inline-flex shrink-0 text-xs font-semibold text-primary hover:underline"
        >
          View details
        </Link>
      </div>
    </div>
  );
}
