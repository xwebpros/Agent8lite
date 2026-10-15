import { describe, expect, it } from "vitest";
import {
  ciContainerId,
  verifyCiContainerOwnership,
  verifyCiDatabaseTarget,
  verifyCiImageAndNetwork,
} from "./ci-ownership.mjs";

const id = "1".repeat(64);
const imageId = `sha256:${"2".repeat(64)}`;
const networkId = "3".repeat(64);
const volumeName = "4".repeat(64);
const networkName = `github_network_${"5".repeat(32)}`;
const environment = { CI: "true", GITHUB_ACTIONS: "true", IDX_TEST_SERVICE_CONTAINER: id };
const container = () => ({
  Id: id,
  Name: "/github_idx_postgres_fixture",
  Image: imageId,
  State: {
    Status: "running",
    Running: true,
    Paused: false,
    Restarting: false,
    Pid: 4567,
    Health: { Status: "healthy" },
    StartedAt: "2026-10-13T01:00:00.000Z",
  },
  Config: {
    Image: "postgis/postgis:17-3.5",
    Cmd: ["postgres"],
    Env: ["PGDATA=/var/lib/postgresql/data", "POSTGRES_DB=postgres", "POSTGRES_PASSWORD=idx-migration-only"],
  },
  HostConfig: {
    Privileged: false,
    PublishAllPorts: false,
    Binds: [] as string[],
    Mounts: [] as object[],
    VolumesFrom: [] as string[],
    CapAdd: [] as string[],
    NetworkMode: networkName,
    PortBindings: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "54434" }] },
  },
  Mounts: [
    {
      Type: "volume",
      Driver: "local",
      Name: volumeName,
      Source: `/var/lib/docker/volumes/${volumeName}/_data`,
      Destination: "/var/lib/postgresql/data",
      RW: true,
    },
  ],
  NetworkSettings: {
    Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "54434" }] },
    Networks: {
      [networkName]: {
        NetworkID: networkId,
        IPAddress: "172.18.0.4",
        GlobalIPv6Address: "",
        Aliases: ["idx-postgres", "github_idx_postgres_fixture"],
      },
    },
  },
});
const image = () => ({ Id: imageId, RepoTags: ["postgis/postgis:17-3.5"] });
const network = () => ({
  Id: networkId,
  Name: networkName,
  Driver: "bridge",
  Scope: "local",
  EnableIPv6: false,
  Containers: {
    [id]: { Name: "github_idx_postgres_fixture", IPv4Address: "172.18.0.4/16", IPv6Address: "" },
  },
});
const ownership = () => verifyCiContainerOwnership(container(), id, environment, "linux");

describe("explicit GitHub Actions dedicated service ownership", () => {
  it("keeps ordinary local/CI execution on the native ownership path unless Actions explicitly supplies the service ID", () => {
    expect(ciContainerId({}, "win32")).toBeUndefined();
    expect(ciContainerId({ CI: "true" }, "linux")).toBeUndefined();
    expect(ciContainerId(environment, "linux")).toBe(id);
  });
  it.each([
    { ...environment, CI: "false" },
    { ...environment, GITHUB_ACTIONS: "false" },
    { ...environment, IDX_TEST_SERVICE_CONTAINER: "short-name" },
    { ...environment, IDX_TEST_SERVICE_CONTAINER: ` ${id}` },
    { ...environment, IDX_TEST_SERVICE_CONTAINER: "--format=malicious" },
    { CI: "true", GITHUB_ACTIONS: "true" },
  ])("rejects an incomplete or spoofed service context %o", (env) => {
    expect(() => ciContainerId(env, "linux")).toThrow();
  });
  it("does not bypass the Windows marker using a forged Actions flag", () => {
    expect(() => ciContainerId(environment, "win32")).toThrow("idx_test_ci_context_invalid");
  });
  it("validates one exact service, real image/network metadata, and the server's container-local database identity", () => {
    const proof = ownership();
    expect(proof).toMatchObject({
      containerId: id,
      hostPort: 54434,
      internalPort: 5432,
      dataDirectory: "/var/lib/postgresql/data",
    });
    expect(() => verifyCiImageAndNetwork(proof, image(), network())).not.toThrow();
    expect(() =>
      verifyCiDatabaseTarget(
        proof,
        {
          directory: proof.dataDirectory,
          port: "5432",
          database: "postgres",
          current_user: "postgres",
          session_user: "postgres",
        },
        true,
      ),
    ).not.toThrow();
  });

  const poisoned: [string, (value: ReturnType<typeof container>) => void][] = [
    [
      "a different actual container ID",
      (value) => {
        value.Id = "6".repeat(64);
      },
    ],
    [
      "an unexpected image tag",
      (value) => {
        value.Config.Image = "postgres:17";
      },
    ],
    [
      "a missing actual image digest",
      (value) => {
        value.Image = "postgis/postgis:17-3.5";
      },
    ],
    [
      "an exited process",
      (value) => {
        value.State.Status = "exited";
      },
    ],
    [
      "a paused process",
      (value) => {
        value.State.Paused = true;
      },
    ],
    [
      "a restarting process",
      (value) => {
        value.State.Restarting = true;
      },
    ],
    [
      "an unhealthy process",
      (value) => {
        value.State.Health.Status = "unhealthy";
      },
    ],
    [
      "an invalid PID",
      (value) => {
        value.State.Pid = 0;
      },
    ],
    [
      "a changed native startup command",
      (value) => {
        value.Config.Cmd = ["postgres", "-p", "55432"];
      },
    ],
    [
      "an external IPv4 bind",
      (value) => {
        value.HostConfig.PortBindings["5432/tcp"][0].HostIp = "0.0.0.0";
      },
    ],
    [
      "an external IPv6 bind",
      (value) => {
        value.NetworkSettings.Ports["5432/tcp"][0].HostIp = "::";
      },
    ],
    [
      "the ordinary application DB port",
      (value) => {
        value.HostConfig.PortBindings["5432/tcp"][0].HostPort = "55432";
      },
    ],
    [
      "a mismatch in actual port mappings",
      (value) => {
        value.NetworkSettings.Ports["5432/tcp"][0].HostPort = "3001";
      },
    ],
    [
      "an additional host port mapping",
      (value) => {
        value.HostConfig.PortBindings["5432/tcp"].push({ HostIp: "127.0.0.1", HostPort: "55432" });
      },
    ],
    [
      "publish-all exposure",
      (value) => {
        value.HostConfig.PublishAllPorts = true;
      },
    ],
    [
      "a host filesystem bind",
      (value) => {
        value.HostConfig.Binds.push("/private/data:/var/lib/postgresql/data");
      },
    ],
    [
      "a host mount disguised as normal PGDATA",
      (value) => {
        value.Mounts[0].Type = "bind";
      },
    ],
    [
      "a reused named data volume",
      (value) => {
        value.Mounts[0].Name = "production-data";
      },
    ],
    [
      "a private host volume source",
      (value) => {
        value.Mounts[0].Source = "/private/postgres/data";
      },
    ],
    [
      "an additional filesystem mount",
      (value) => {
        value.Mounts.push({ ...value.Mounts[0], Destination: "/workspace" });
      },
    ],
    [
      "volumes inherited from another container",
      (value) => {
        value.HostConfig.VolumesFrom.push("user-postgres");
      },
    ],
    [
      "privileged service execution",
      (value) => {
        value.HostConfig.Privileged = true;
      },
    ],
    [
      "the host network",
      (value) => {
        value.HostConfig.NetworkMode = "host";
      },
    ],
    [
      "an externally addressed network endpoint",
      (value) => {
        value.NetworkSettings.Networks[networkName].IPAddress = "203.0.113.1";
      },
    ],
    [
      "a missing dedicated service alias",
      (value) => {
        value.NetworkSettings.Networks[networkName].Aliases = ["postgres"];
      },
    ],
    [
      "an unexpected postgres data directory",
      (value) => {
        value.Config.Env[0] = "PGDATA=/private/data";
      },
    ],
    [
      "the application migration credential",
      (value) => {
        value.Config.Env[2] = "POSTGRES_PASSWORD=local-migration-only";
      },
    ],
    [
      "the application database",
      (value) => {
        value.Config.Env[1] = "POSTGRES_DB=estate";
      },
    ],
    [
      "duplicate credential environment entries",
      (value) => {
        value.Config.Env.push("POSTGRES_PASSWORD=idx-migration-only");
      },
    ],
  ];
  it.each(poisoned)("rejects %s before any database effect", (_name, change) => {
    const value = container();
    change(value);
    expect(() => verifyCiContainerOwnership(value, id, environment, "linux")).toThrow();
  });
  it("cannot substitute a different approved-looking ID for the job service context", () => {
    expect(() => verifyCiContainerOwnership(container(), "6".repeat(64), environment, "linux")).toThrow();
  });
  it("checks actual daemon image and network identities separately from the container's declarations", () => {
    const proof = ownership();
    expect(() =>
      verifyCiImageAndNetwork(proof, { ...image(), Id: `sha256:${"6".repeat(64)}` }, network()),
    ).toThrow("idx_test_ci_actual_image_invalid");
    expect(() => verifyCiImageAndNetwork(proof, image(), { ...network(), Id: "6".repeat(64) })).toThrow(
      "idx_test_ci_actual_network_invalid",
    );
    expect(() => verifyCiImageAndNetwork(proof, image(), { ...network(), Driver: "host" })).toThrow(
      "idx_test_ci_actual_network_invalid",
    );
    const replaced = network();
    replaced.Containers[id].Name = "other-postgres";
    expect(() => verifyCiImageAndNetwork(proof, image(), replaced)).toThrow(
      "idx_test_ci_actual_endpoint_invalid",
    );
  });
  it.each([
    { directory: "/private/data" },
    { port: "54434" },
    { database: "estate" },
    { current_user: "estate_runtime" },
    { session_user: "estate_runtime" },
  ])("requires the actual PostgreSQL target to match its container proof: %o", (change) => {
    const proof = ownership();
    expect(() =>
      verifyCiDatabaseTarget(
        proof,
        {
          directory: proof.dataDirectory,
          port: "5432",
          database: "postgres",
          current_user: "postgres",
          session_user: "postgres",
          ...change,
        },
        true,
      ),
    ).toThrow("idx_test_ci_database_target_invalid");
  });
  it("requires actual PostGIS availability", () => {
    const proof = ownership();
    expect(() =>
      verifyCiDatabaseTarget(
        proof,
        {
          directory: proof.dataDirectory,
          port: "5432",
          database: "postgres",
          current_user: "postgres",
          session_user: "postgres",
        },
        false,
      ),
    ).toThrow("idx_test_postgis_unavailable");
  });
});
