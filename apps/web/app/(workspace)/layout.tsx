import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import Workspace from "../../components/workspace";

export const dynamic = "force-dynamic";

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  if (process.env.HOSTED_DEMO_ENABLED === "true") redirect("/demo");
  const syntheticFeaturesEnabled =
    ["development", "test"].includes(process.env.APP_ENV || "") && process.env.DEV_AUTH_ENABLED === "true";

  return (
    <>
      <Workspace syntheticFeaturesEnabled={syntheticFeaturesEnabled} />
      {children}
    </>
  );
}
