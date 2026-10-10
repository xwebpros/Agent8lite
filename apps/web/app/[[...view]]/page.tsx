import Workspace from "../../components/workspace";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";
export default function Page() {
  if (process.env.HOSTED_DEMO_ENABLED === "true") redirect("/demo");
  const syntheticFeaturesEnabled =
    ["development", "test"].includes(process.env.APP_ENV || "") && process.env.DEV_AUTH_ENABLED === "true";
  return <Workspace syntheticFeaturesEnabled={syntheticFeaturesEnabled} />;
}
