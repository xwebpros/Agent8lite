import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./settings-sections.css";
import "./data-transfer.css";
import "./administration.css";
import "./routing-capture.css";

export const metadata: Metadata = {
  title: "Estate — Real estate workspace",
  description: "Your real estate relationships, organized. Synthetic development workspace.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Estate" },
  icons: { icon: "/icons/app-192.png", apple: "/icons/apple-touch-icon.png" },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#15263F",
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
