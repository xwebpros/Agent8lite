"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { PublishedSiteProvider, type TemplateContent } from "./context";
import Home from "./pages/Home";
import ListingDetail from "./pages/ListingDetail";
import LocationPage from "./pages/LocationPage";
import SavedHomes from "./pages/SavedHomes";
import Organizer from "./pages/Organizer";
import Account from "./pages/Account";
import Terms from "./pages/Terms";
import "./template.css";
export default function IdxTemplateApp({ site, path = [] }: { site: TemplateContent; path?: string[] }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: true } },
      }),
  );
  const route = path.join("/");
  const page = !route ? (
    <Home />
  ) : path[0] === "listing" && path.length === 2 ? (
    <ListingDetail />
  ) : path[0] === "communities" && path.length === 2 ? (
    <LocationPage />
  ) : ["saved-homes", "account/favorites"].includes(route) ? (
    <SavedHomes />
  ) : route === "account/organizer" ? (
    <Organizer />
  ) : route === "terms" ? (
    <Terms />
  ) : route === "account" || route === "account/verify" ? (
    <Account />
  ) : (
    <div className="p-12">
      <h1 className="font-serif text-4xl">Page unavailable</h1>
      <p className="mt-4">This public template route does not exist.</p>
    </div>
  );
  return (
    <QueryClientProvider client={client}>
      <PublishedSiteProvider site={site}>
        <div data-idx-template className="idx-template">
          {page}
        </div>
      </PublishedSiteProvider>
    </QueryClientProvider>
  );
}
