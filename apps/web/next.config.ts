import type { NextConfig } from "next";

const config: NextConfig = {
  distDir: process.env.ESTATE_BUILD_DIR || ".next",
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/demo/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};
export default config;
