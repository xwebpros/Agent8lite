import type { MetadataRoute } from "next";
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/workspace",
    name: "Estate — Real Estate Workspace",
    short_name: "Estate",
    description: "Independent real estate SaaS workspace",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#F5F7FB",
    theme_color: "#15263F",
    icons: [
      { src: "/icons/app-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/app-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/app-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
