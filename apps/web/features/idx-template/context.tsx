"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { components } from "../../../../packages/contracts/generated/api";
import { useInquiryRegistry } from "./inquiry-session";

export type TemplateContent = components["schemas"]["IdxTemplateContent"];
const SiteContext = createContext<TemplateContent | null>(null);
const OriginContext = createContext("");
export function useTemplateOrigin() {
  return useContext(OriginContext);
}
export function useTemplateSite() {
  const site = useContext(SiteContext);
  if (!site) throw new Error("Published template context is required.");
  return site;
}
export function PublishedSiteProvider({
  site,
  children,
  origin = "",
}: {
  site: TemplateContent;
  children: ReactNode;
  origin?: string;
}) {
  const registry = useInquiryRegistry();
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
    window.addEventListener("online", expire);
    document.addEventListener("visibilitychange", expire);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", expire);
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
          onClick={() => {
            if (registry.all().some((controller) => controller.hasUnresolvedCommand)) {
              for (const controller of registry.all()) controller.explainNavigationGuard();
              return;
            }
            window.location.reload();
          }}
        >
          Reload site
        </button>
      </div>
    );
  return (
    <OriginContext.Provider value={origin}>
      <SiteContext.Provider value={site}>{children}</SiteContext.Provider>
    </OriginContext.Provider>
  );
}
