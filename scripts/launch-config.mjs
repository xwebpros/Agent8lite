// A supplied PORT, even an invalid/empty one, must never fall back to local ports.
export function hostedLaunchRequired(environment) {
  return (
    Object.hasOwn(environment, "PORT") ||
    environment.NODE_ENV === "production" ||
    environment.APP_ENV === "production" ||
    environment.HOSTED_DEMO_ENABLED === "true"
  );
}

// Hosted launch deliberately does not inherit local development/provider settings.
export function launchConfiguration(environment, workspace, nodeVersion = process.version) {
  if (nodeVersion !== `v${workspace.engines.node}`) throw new Error("launch_node_version_invalid");
  const portText = environment.PORT;
  if (!/^[1-9][0-9]{0,4}$/.test(portText ?? "") || Number(portText) > 65535)
    throw new Error("launch_port_required");
  const demo = environment.HOSTED_DEMO_ENABLED === "true";
  if (demo) {
    if (
      typeof environment.DEMO_ACCESS_PASSWORD !== "string" ||
      environment.DEMO_ACCESS_PASSWORD.length < 16 ||
      environment.DEMO_ACCESS_PASSWORD.length > 128 ||
      typeof environment.DEMO_SESSION_SECRET !== "string" ||
      environment.DEMO_SESSION_SECRET.length < 32 ||
      environment.DEMO_SESSION_SECRET.length > 256
    )
      throw new Error("launch_demo_secrets_required");
  } else {
    try {
      const database = new URL(environment.DATABASE_URL);
      if (
        !["postgres:", "postgresql:"].includes(database.protocol) ||
        !database.hostname ||
        !database.pathname.slice(1)
      )
        throw new Error();
    } catch {
      throw new Error("launch_database_url_required");
    }
  }
  let origin;
  try {
    origin = new URL(environment.WEB_ORIGIN);
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      origin.origin !== environment.WEB_ORIGIN
    )
      throw new Error();
  } catch {
    throw new Error("launch_web_origin_required");
  }
  if (demo && origin.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
    throw new Error("launch_web_origin_required");
  const buildDirectory = environment.ESTATE_BUILD_DIR || ".next";
  if (![".next", ".next-build"].includes(buildDirectory)) throw new Error("launch_build_directory_invalid");
  const common = {};
  for (const [key, value] of Object.entries(environment))
    if (
      value !== undefined &&
      ["systemroot", "windir", "path", "temp", "tmp", "home", "userprofile", "lang", "lc_all", "tz"].includes(
        key.toLowerCase(),
      )
    )
      common[key] = value;
  Object.assign(common, {
    NODE_ENV: "production",
    APP_ENV: "production",
    DEV_AUTH_ENABLED: "false",
    WEB_ORIGIN: origin.origin,
    NEXT_TELEMETRY_DISABLED: "1",
  });
  return {
    mode: demo ? "demo" : "application",
    port: Number(portText),
    buildDirectory,
    apiEnvironment: {
      ...common,
      DATABASE_URL: environment.DATABASE_URL,
      API_HOST: "127.0.0.1",
      API_PORT: "0",
      MLS_PROVIDER: "mock",
      DELIVERY_PROVIDER: "no-delivery",
    },
    webEnvironment(apiPort) {
      if (!demo && (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535))
        throw new Error("launch_api_port_invalid");
      return {
        ...common,
        PORT: portText,
        ESTATE_BUILD_DIR: buildDirectory,
        ...(demo
          ? {
              HOSTED_DEMO_ENABLED: "true",
              DEMO_ACCESS_PASSWORD: environment.DEMO_ACCESS_PASSWORD,
              DEMO_SESSION_SECRET: environment.DEMO_SESSION_SECRET,
            }
          : { HOSTED_DEMO_ENABLED: "false", API_ORIGIN: `http://127.0.0.1:${apiPort}` }),
      };
    },
  };
}
