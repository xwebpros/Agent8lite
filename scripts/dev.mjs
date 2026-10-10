import { hostedLaunchRequired } from "./launch-config.mjs";

// Some hosts select npm run dev automatically. Select the same production path
// as npm start before importing any synthetic settings or development packages.
if (hostedLaunchRequired(process.env)) {
  console.log(JSON.stringify({ status: "hosted-launch-selected", command: "npm start" }));
  const { runApplication } = await import("./start-app.mjs");
  await runApplication();
} else await import("./dev-local.mjs");
