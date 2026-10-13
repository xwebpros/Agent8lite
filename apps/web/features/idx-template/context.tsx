"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { components } from "../../../../packages/contracts/generated/api";

export type TemplateContent = components["schemas"]["IdxTemplateContent"];
const SiteContext = createContext<TemplateContent | null>(null);
export function useTemplateSite() {
  const site = useContext(SiteContext);
  if (!site) throw new Error("Published template context is required.");
  return site;
}
export function PublishedSiteProvider({ site, children }: { site: TemplateContent; children: ReactNode }) {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const expire = () =>
      setExpired(
        !navigator.onLine ||
          !Number.isFinite(Date.parse(site.expiresAt)) ||
          Date.now() >= Date.parse(site.expiresAt),
      );
    expire();
    const timer = setTimeout(
      expire,
      Math.max(0, Math.min(2147483647, Date.parse(site.expiresAt) - Date.now())),
    );
    const offline = () => setExpired(true);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", expire);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", expire);
    };
  }, [site.expiresAt]);
  if (expired)
    return (
      <div className="idx-template min-h-screen bg-background p-12 text-foreground" data-idx-template>
        <h1 className="font-serif text-4xl">This site needs a fresh connection</h1>
        <p className="mt-4">
          The published site or property policy has expired. Reload while online to verify current
          availability.
        </p>
        <button
          type="button"
          className="mt-6 rounded bg-primary px-5 py-3 text-primary-foreground"
          onClick={() => window.location.reload()}
        >
          Reload site
        </button>
      </div>
    );
  return <SiteContext.Provider value={site}>{children}</SiteContext.Provider>;
}
