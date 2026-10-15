"use client";
import NextLink from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ComponentProps } from "react";
import { useTemplateSite } from "./context";

export function sitePath(siteId: string, href: string) {
  if (href === "/workspace" || href === "/agent") return "/dashboard";
  if (href === "/admin") return "/settings";
  if (!href.startsWith("/") || href.startsWith("//")) return href.startsWith("https:") ? href : "#";
  return `/templates/las-vegas-idx/${encodeURIComponent(siteId)}${href === "/" ? "" : href}`;
}
export function Link({ href, ...props }: Omit<ComponentProps<typeof NextLink>, "href"> & { href: string }) {
  const site = useTemplateSite();
  return <NextLink href={sitePath(site.siteId, href)} {...props} />;
}
export function useLocation(): [string, (href: string) => void] {
  const site = useTemplateSite();
  const pathname = usePathname();
  const query = useSearchParams();
  const router = useRouter();
  const prefix = `/templates/las-vegas-idx/${site.siteId}`;
  return [
    (pathname.slice(prefix.length) || "/") + (query.size ? `?${query}` : ""),
    (href) => router.push(sitePath(site.siteId, href)),
  ];
}
export function useParams(): Record<string, string> {
  const [location] = useLocation();
  return { listingKey: decodeURIComponent(location.split("?")[0].split("/listing/")[1] ?? "") };
}
export function useRoute<T extends Record<string, string>>(_pattern: string): [boolean, T | null] {
  const [location] = useLocation();
  const slug = location.split("?")[0].split("/communities/")[1];
  return [Boolean(slug), slug ? ({ slug: decodeURIComponent(slug) } as unknown as T) : null];
}
export function templateSearch() {
  return typeof window === "undefined" ? "" : window.location.search;
}
export function replaceTemplateUrl(href: string) {
  const match = /^\/templates\/las-vegas-idx\/([^/]+)/.exec(window.location.pathname);
  if (match) window.history.replaceState(null, "", sitePath(decodeURIComponent(match[1]), href));
}
