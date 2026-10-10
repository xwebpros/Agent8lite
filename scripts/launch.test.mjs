import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { hostedLaunchRequired, launchConfiguration } from "./launch-config.mjs";
import { supervise } from "./start-app.mjs";

const workspace = { engines: { node: "24.19.0" } };
const environment = {
  PORT: "43127",
  WEB_ORIGIN: "https://demo.example.com",
  DATABASE_URL: "postgresql://runtime:fixture@127.0.0.1:55432/estate",
};
const configure = (extra) => launchConfiguration({ ...environment, ...extra }, workspace, "v24.19.0");

describe("development command host selection", () => {
  it.each([
    { PORT: "43127" },
    { PORT: "3000", NODE_ENV: "development", APP_ENV: "test", DEV_AUTH_ENABLED: "true" },
    { PORT: "" },
    { PORT: undefined },
    { PORT: "invalid" },
    { NODE_ENV: "production" },
    { APP_ENV: "production" },
    { HOSTED_DEMO_ENABLED: "true" },
  ])("selects production before local defaults for %s", (env) =>
    expect(hostedLaunchRequired(env)).toBe(true),
  );
  it.each([
    {},
    { NODE_ENV: "development", APP_ENV: "development", DEV_AUTH_ENABLED: "true" },
    { NODE_ENV: "test", APP_ENV: "test", DEV_AUTH_ENABLED: "true" },
    { HOSTED_DEMO_ENABLED: "false" },
  ])("keeps ordinary loopback development for %s", (env) => expect(hostedLaunchRequired(env)).toBe(false));
});

describe("host launch boundary", () => {
  it.each([undefined, "", "0", "-1", "1.5", "3000junk", "03000", "65536", "999999", " 3000"])(
    "rejects assigned port %s",
    (PORT) => {
      expect(() => configure({ PORT })).toThrow("launch_port_required");
    },
  );
  it.each(["1", "3000", "65535"])("uses assigned port %s", (PORT) =>
    expect(configure({ PORT }).port).toBe(Number(PORT)),
  );
  it("requires the pinned Node runtime", () =>
    expect(() => launchConfiguration(environment, workspace, "v22.0.0")).toThrow(
      "launch_node_version_invalid",
    ));
  it.each([undefined, "", "http://localhost/db", "postgresql:///estate", "postgresql://localhost/"])(
    "rejects missing or invalid database %s",
    (DATABASE_URL) => {
      expect(() => configure({ DATABASE_URL })).toThrow("launch_database_url_required");
    },
  );
  it.each([
    undefined,
    "",
    "https://demo.example.com/path",
    "https://demo.example.com/",
    "https://user:secret@demo.example.com",
    "https://demo.example.com?x=1",
    "file:///root",
  ])("rejects web origin %s", (WEB_ORIGIN) => {
    expect(() => configure({ WEB_ORIGIN })).toThrow("launch_web_origin_required");
  });
  it("isolates secrets and overrides inherited synthetic/provider/private listener settings", () => {
    const config = configure({
      APP_ENV: "test",
      DEV_AUTH_ENABLED: "true",
      NODE_ENV: "development",
      API_HOST: "0.0.0.0",
      API_PORT: "3001",
      API_ORIGIN: "https://wrong.example",
      MIGRATION_DATABASE_URL: "secret",
      CONTROL_DATABASE_URL: "secret",
      STAFF_ISSUER_DATABASE_URL: "secret",
      TRESTLE_CLIENT_SECRET: "secret",
      MLS_PROVIDER: "trestle",
      DELIVERY_PROVIDER: "real",
      NODE_OPTIONS: "--import=secret",
      NEXT_PUBLIC_DATABASE_URL: "secret",
      PATH: "/bin",
      ESTATE_BUILD_DIR: ".next-build",
    });
    expect(config.apiEnvironment).toMatchObject({
      APP_ENV: "production",
      DEV_AUTH_ENABLED: "false",
      NODE_ENV: "production",
      API_HOST: "127.0.0.1",
      API_PORT: "0",
      DATABASE_URL: environment.DATABASE_URL,
      MLS_PROVIDER: "mock",
      DELIVERY_PROVIDER: "no-delivery",
    });
    const web = config.webEnvironment(45213);
    expect(web).toMatchObject({
      PORT: "43127",
      API_ORIGIN: "http://127.0.0.1:45213",
      ESTATE_BUILD_DIR: ".next-build",
      PATH: "/bin",
      APP_ENV: "production",
      DEV_AUTH_ENABLED: "false",
    });
    for (const env of [web, config.apiEnvironment])
      for (const name of [
        "MIGRATION_DATABASE_URL",
        "CONTROL_DATABASE_URL",
        "STAFF_ISSUER_DATABASE_URL",
        "TRESTLE_CLIENT_SECRET",
        "NODE_OPTIONS",
        "NEXT_PUBLIC_DATABASE_URL",
      ])
        expect(env).not.toHaveProperty(name);
    expect(web).not.toHaveProperty("DATABASE_URL");
  });
  it.each([0, -1, 65536, "3001", NaN])("rejects invalid private IPC port %s", (port) =>
    expect(() => configure().webEnvironment(port)).toThrow("launch_api_port_invalid"),
  );
  it("rejects build directory traversal", () =>
    expect(() => configure({ ESTATE_BUILD_DIR: "../../.local" })).toThrow("launch_build_directory_invalid"));
});

function harness(options = {}) {
  const calls = [];
  const spawnChild = (executable, args, config) => {
    const child = new EventEmitter();
    child.pid = calls.length + 100;
    child.connected = true;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.sent = [];
    child.killed = [];
    child.send = (message, callback) => {
      child.sent.push(message);
      callback?.();
      if (!options.ignoreShutdown)
        queueMicrotask(() => {
          child.connected = false;
          child.emit("close", 0);
        });
    };
    child.kill = (signal) => {
      child.killed.push(signal);
      queueMicrotask(() => child.emit("close", 0));
      return true;
    };
    calls.push({ executable, args, config, child });
    return child;
  };
  const application = supervise(options.config ?? configure(), { spawnChild, startupMs: 100, shutdownMs: 5 });
  application.ready.catch(() => {});
  return { calls, application };
}
function apiReady(h, port = 45213) {
  h.calls[0].child.emit("message", { type: "estate-api-ready", port });
}
function webReady(h) {
  h.calls[1].child.stdout.write("▲ Next.js 16.4.0\n✓ Ready in 150ms\n");
}

describe("owned process supervision", () => {
  it("starts only web for explicit hosted demo, without database or providers", async () => {
    const config = configure({
      HOSTED_DEMO_ENABLED: "true",
      DATABASE_URL: undefined,
      DEMO_ACCESS_PASSWORD: "fixture-preview-password",
      DEMO_SESSION_SECRET: "fixture-session-secret-at-least-thirty-two",
    });
    const h = harness({ config });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].args).toContain("start");
    expect(h.calls[0].config.env).not.toHaveProperty("DATABASE_URL");
    expect(h.calls[0].config.env).not.toHaveProperty("API_ORIGIN");
    h.calls[0].child.stdout.write("✓ Ready in 150ms\n");
    await expect(h.application.ready).resolves.toMatchObject({ port: 43127, apiPort: undefined });
    await expect(h.application.stop()).resolves.toBe(0);
  });
  it.each([
    { DEMO_ACCESS_PASSWORD: "short" },
    { DEMO_SESSION_SECRET: "short" },
    { DEMO_ACCESS_PASSWORD: undefined },
  ])("requires preview secrets %s", (extra) => {
    expect(() =>
      configure({
        HOSTED_DEMO_ENABLED: "true",
        DEMO_ACCESS_PASSWORD: "fixture-preview-password",
        DEMO_SESSION_SECRET: "fixture-session-secret-at-least-thirty-two",
        ...extra,
      }),
    ).toThrow("launch_demo_secrets_required");
  });
  it("requires HTTPS for a public preview", () =>
    expect(() =>
      configure({
        HOSTED_DEMO_ENABLED: "true",
        DEMO_ACCESS_PASSWORD: "fixture-preview-password",
        DEMO_SESSION_SECRET: "fixture-session-secret-at-least-thirty-two",
        WEB_ORIGIN: "http://demo.example.com",
      }),
    ).toThrow("launch_web_origin_required"));
  it("starts the web only after owned API IPC, ignores duplicate readiness, and closes both", async () => {
    const h = harness();
    expect(h.calls).toHaveLength(1);
    h.calls[0].child.stdout.write("ready\n");
    expect(h.calls).toHaveLength(1);
    apiReady(h);
    apiReady(h, 55555);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].args.slice(-4)).toEqual(["--hostname", "0.0.0.0", "--port", "43127"]);
    expect(h.calls[1].config.env.API_ORIGIN).toBe("http://127.0.0.1:45213");
    h.calls[1].child.stdout.write("not ready\n");
    webReady(h);
    await expect(h.application.ready).resolves.toMatchObject({ port: 43127, apiPort: 45213 });
    await expect(h.application.stop()).resolves.toBe(0);
    expect(h.calls[0].child.sent).toEqual([{ type: "estate-shutdown" }]);
    expect(h.calls[1].child.killed).toEqual(["SIGTERM"]);
  });
  it("fails and closes API when web exits during startup", async () => {
    const h = harness();
    apiReady(h);
    h.calls[1].child.emit("close", 1);
    await expect(h.application.done).resolves.toBe(1);
    expect(h.calls[0].child.sent).toHaveLength(1);
  });
  it("closes web after an unexpected API exit after readiness", async () => {
    const h = harness();
    apiReady(h);
    webReady(h);
    await h.application.ready;
    h.calls[0].child.emit("close", 1);
    await expect(h.application.done).resolves.toBe(1);
    expect(h.calls[1].child.killed).toEqual(["SIGTERM"]);
  });
  it("rejects invalid IPC readiness without opening web", async () => {
    const h = harness();
    apiReady(h, 0);
    await expect(h.application.done).resolves.toBe(1);
    expect(h.calls).toHaveLength(1);
  });
  it("bounds stalled startup and escalates an ignored API shutdown", async () => {
    const h = harness({ ignoreShutdown: true });
    await expect(h.application.done).resolves.toBe(1);
    expect(h.calls[0].child.killed).toEqual(["SIGKILL"]);
  });
  it("bounds oversized startup output", async () => {
    const h = harness();
    apiReady(h);
    h.calls[1].child.stdout.write("x".repeat(65537));
    await expect(h.application.done).resolves.toBe(1);
  });
  it("fails safely when the owned API cannot spawn", async () => {
    const h = harness();
    h.calls[0].child.pid = undefined;
    h.calls[0].child.emit("error", new Error("private config"));
    await expect(h.application.done).resolves.toBe(1);
    expect(h.calls).toHaveLength(1);
  });
});
