import StaffWorkspace from "../../../components/staff-workspace";

export const dynamic = "force-dynamic";
export default function StaffPage() {
  const enabled =
    ["development", "test"].includes(process.env.APP_ENV || "") &&
    process.env.DEV_AUTH_ENABLED === "true" &&
    Boolean(process.env.CONTROL_DATABASE_URL) &&
    Boolean(process.env.STAFF_ISSUER_DATABASE_URL);
  return <StaffWorkspace syntheticFeaturesEnabled={enabled} />;
}
