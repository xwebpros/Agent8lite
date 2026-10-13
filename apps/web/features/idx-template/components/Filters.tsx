"use client";

import { useState, useEffect } from "react";
import { ListListingsParams, ListListingsSort } from "../api";
import { Search, SlidersHorizontal, X } from "lucide-react";

interface FiltersProps {
  initialFilters: ListListingsParams;
  onFilterChange: (filters: ListListingsParams) => void;
  isLoading: boolean;
}

export function Filters({ initialFilters, onFilterChange, isLoading }: FiltersProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [localFilters, setLocalFilters] = useState<ListListingsParams>(initialFilters);

  // Sync when initialFilters change from outside (like URL changes)
  useEffect(() => {
    setLocalFilters(initialFilters);
  }, [initialFilters]);

  const handleApply = () => {
    onFilterChange({ ...localFilters, page: 1 });
    setIsOpen(false);
  };

  const handleClear = () => {
    const cleared = { sort: ListListingsSort.newest, page: 1 };
    setLocalFilters(cleared);
    onFilterChange(cleared);
    setIsOpen(false);
  };

  const updateFilter = (key: keyof ListListingsParams, value: any) => {
    setLocalFilters((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="w-full mb-8">
      <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
        <div className="relative w-full md:max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground w-4 h-4" />
          <input
            type="text"
            aria-label="Search listings by address"
            placeholder="Search by address (e.g. 123 Main St)..."
            className="w-full pl-10 pr-4 py-3 bg-card border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 transition-shadow"
            value={localFilters.address || ""}
            onChange={(e) => updateFilter("address", e.target.value || undefined)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleApply();
            }}
          />
        </div>

        <div className="flex items-center gap-3 w-full md:w-auto">
          <select
            aria-label="Sort listings"
            className="flex-1 md:flex-none h-11 px-4 py-2 bg-card border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            value={localFilters.sort || ListListingsSort.newest}
            onChange={(e) => {
              const val = e.target.value as ListListingsSort;
              updateFilter("sort", val);
              onFilterChange({ ...localFilters, sort: val, page: 1 });
            }}
          >
            <option value={ListListingsSort.newest}>Newest Listings</option>
            <option value={ListListingsSort["price-asc"]}>Price: Low to High</option>
            <option value={ListListingsSort["price-desc"]}>Price: High to Low</option>
          </select>

          <button
            type="button"
            aria-expanded={isOpen}
            aria-controls="property-filters"
            onClick={() => setIsOpen(!isOpen)}
            className="flex items-center gap-2 h-11 px-4 py-2 bg-card border border-border rounded-md text-sm font-medium hover:bg-muted transition-colors"
          >
            <SlidersHorizontal className="w-4 h-4" />
            <span className="hidden sm:inline">Filters</span>
          </button>
        </div>
      </div>

      {isOpen && (
        <div
          id="property-filters"
          className="mt-4 p-5 bg-card border border-border rounded-lg shadow-sm animate-in fade-in slide-in-from-top-2 duration-200"
        >
          <div className="flex items-center justify-between mb-5">
            <h3 className="font-serif font-medium text-lg">Filter Properties</h3>
            <button
              type="button"
              aria-label="Close filters"
              onClick={() => setIsOpen(false)}
              className="h-9 w-9 inline-flex items-center justify-center text-muted-foreground hover:text-foreground rounded-full hover:bg-muted"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="space-y-4">
              <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Listing</h4>
              <div className="space-y-3">
                <select
                  aria-label="Listing status"
                  className="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  value={localFilters.status || "Active"}
                  onChange={(e) => updateFilter("status", e.target.value || undefined)}
                >
                  <option value="Active">Active</option>
                  <option value="ActiveUnderContract">Active Under Contract</option>
                  <option value="Pending">Pending</option>
                </select>
                <select
                  aria-label="Property type"
                  className="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  value={localFilters.propertyType || ""}
                  onChange={(e) => updateFilter("propertyType", e.target.value || undefined)}
                >
                  <option value="">Any Property Type</option>
                  <option value="Residential">Residential</option>
                  <option value="HighRise">High-Rise</option>
                  <option value="MultiFamily">Multi-Family</option>
                  <option value="ResidentialIncome">Residential Income</option>
                  <option value="ResidentialLease">Residential Lease</option>
                </select>
                <select
                  aria-label="Property subtype"
                  className="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  value={localFilters.propertySubType || ""}
                  onChange={(e) => updateFilter("propertySubType", e.target.value || undefined)}
                >
                  <option value="">Any Property Subtype</option>
                  <option value="SingleFamilyResidence">Single Family</option>
                  <option value="Condominium">Condominium</option>
                  <option value="Townhouse">Townhouse</option>
                  <option value="Attached">Attached</option>
                  <option value="Detached">Detached</option>
                </select>
              </div>
            </div>

            <div className="space-y-4">
              <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Price Range
              </h4>
              <div className="flex items-center gap-2">
                <input
                  aria-label="Minimum price"
                  type="number"
                  placeholder="Min"
                  className="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  value={localFilters.minPrice || ""}
                  onChange={(e) =>
                    updateFilter("minPrice", e.target.value ? Number(e.target.value) : undefined)
                  }
                />
                <span className="text-muted-foreground">-</span>
                <input
                  aria-label="Maximum price"
                  type="number"
                  placeholder="Max"
                  className="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  value={localFilters.maxPrice || ""}
                  onChange={(e) =>
                    updateFilter("maxPrice", e.target.value ? Number(e.target.value) : undefined)
                  }
                />
              </div>
            </div>

            <div className="space-y-4">
              <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Bedrooms & Bathrooms
              </h4>
              <div className="flex gap-4">
                <div className="flex-1">
                  <select
                    aria-label="Minimum bedrooms"
                    className="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                    value={localFilters.beds || ""}
                    onChange={(e) =>
                      updateFilter("beds", e.target.value ? Number(e.target.value) : undefined)
                    }
                  >
                    <option value="">Any Beds</option>
                    <option value="1">1+ Beds</option>
                    <option value="2">2+ Beds</option>
                    <option value="3">3+ Beds</option>
                    <option value="4">4+ Beds</option>
                    <option value="5">5+ Beds</option>
                  </select>
                </div>
                <div className="flex-1">
                  <select
                    aria-label="Minimum bathrooms"
                    className="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                    value={localFilters.baths || ""}
                    onChange={(e) =>
                      updateFilter("baths", e.target.value ? Number(e.target.value) : undefined)
                    }
                  >
                    <option value="">Any Baths</option>
                    <option value="1">1+ Baths</option>
                    <option value="2">2+ Baths</option>
                    <option value="3">3+ Baths</option>
                    <option value="4">4+ Baths</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Location</h4>
              <div>
                <input
                  aria-label="ZIP code"
                  type="text"
                  placeholder="Zip Code"
                  className="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  value={localFilters.zip || ""}
                  onChange={(e) => updateFilter("zip", e.target.value || undefined)}
                />
              </div>
            </div>

            <div className="space-y-4">
              <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Size & Age
              </h4>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="number"
                  min="0"
                  placeholder="Min Sq Ft"
                  aria-label="Minimum square feet"
                  className="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  value={localFilters.minSqft ?? ""}
                  onChange={(e) =>
                    updateFilter("minSqft", e.target.value ? Number(e.target.value) : undefined)
                  }
                />
                <input
                  type="number"
                  min="0"
                  placeholder="Max Sq Ft"
                  aria-label="Maximum square feet"
                  className="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  value={localFilters.maxSqft ?? ""}
                  onChange={(e) =>
                    updateFilter("maxSqft", e.target.value ? Number(e.target.value) : undefined)
                  }
                />
                <input
                  type="number"
                  min="1800"
                  max="2100"
                  placeholder="Built From"
                  aria-label="Minimum year built"
                  className="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  value={localFilters.minYearBuilt ?? ""}
                  onChange={(e) =>
                    updateFilter("minYearBuilt", e.target.value ? Number(e.target.value) : undefined)
                  }
                />
                <input
                  type="number"
                  min="1800"
                  max="2100"
                  placeholder="Built To"
                  aria-label="Maximum year built"
                  className="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  value={localFilters.maxYearBuilt ?? ""}
                  onChange={(e) =>
                    updateFilter("maxYearBuilt", e.target.value ? Number(e.target.value) : undefined)
                  }
                />
              </div>
            </div>

            <div className="space-y-4">
              <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Features</h4>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <label className="flex min-h-9 items-center gap-2">
                  <input
                    aria-label="Homes with pool"
                    type="checkbox"
                    checked={Boolean(localFilters.pool)}
                    onChange={(e) => updateFilter("pool", e.target.checked || undefined)}
                  />
                  Pool
                </label>
                <label className="flex min-h-9 items-center gap-2">
                  <input
                    aria-label="Single story homes"
                    type="checkbox"
                    checked={Boolean(localFilters.singleStory)}
                    onChange={(e) => updateFilter("singleStory", e.target.checked || undefined)}
                  />
                  Single story
                </label>
                <label className="flex min-h-9 items-center gap-2">
                  <input
                    aria-label="Homes with HOA"
                    type="checkbox"
                    checked={Boolean(localFilters.hoa)}
                    onChange={(e) => updateFilter("hoa", e.target.checked || undefined)}
                  />
                  HOA
                </label>
                <label className="flex min-h-9 items-center gap-2">
                  <input
                    aria-label="Gated communities"
                    type="checkbox"
                    checked={Boolean(localFilters.gated)}
                    onChange={(e) => updateFilter("gated", e.target.checked || undefined)}
                  />
                  Gated community
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="number"
                  min="0"
                  max="20"
                  placeholder="Min Garage"
                  aria-label="Minimum garage spaces"
                  className="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  value={localFilters.minGarageSpaces ?? ""}
                  onChange={(e) =>
                    updateFilter("minGarageSpaces", e.target.value ? Number(e.target.value) : undefined)
                  }
                />
                <input
                  type="number"
                  min="0"
                  max="10000000"
                  placeholder="Min Lot Sq Ft"
                  aria-label="Minimum lot size square feet"
                  className="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  value={localFilters.minLotSizeSqft ?? ""}
                  onChange={(e) =>
                    updateFilter("minLotSizeSqft", e.target.value ? Number(e.target.value) : undefined)
                  }
                />
              </div>
            </div>
          </div>

          <div className="mt-6 pt-5 border-t border-border flex justify-end gap-3">
            <button
              type="button"
              onClick={handleClear}
              className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Clear All
            </button>
            <button
              type="button"
              onClick={handleApply}
              disabled={isLoading}
              className="px-6 py-2 bg-primary text-primary-foreground rounded text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-70"
            >
              Apply Filters
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
