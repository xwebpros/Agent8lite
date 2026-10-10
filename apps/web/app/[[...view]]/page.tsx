import Workspace from "../../components/workspace";

export const dynamic = "force-dynamic";
export default function Page() {
  const syntheticFeaturesEnabled =
    ["development", "test"].includes(process.env.APP_ENV || "") && process.env.DEV_AUTH_ENABLED === "true";
  return <Workspace syntheticFeaturesEnabled={syntheticFeaturesEnabled} />;
}
