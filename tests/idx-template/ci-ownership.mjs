import { isIP } from "node:net";

const containerImage = "postgis/postgis:17-3.5";
const dataDirectory = "/var/lib/postgresql/data";
const hexId = /^[a-f0-9]{64}$/;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const empty = (value) =>
  value === null || value === undefined || (Array.isArray(value) && value.length === 0);
const fail = (code) => {
  throw new Error(code);
};

/** Explicit Actions service context is required; no generic CI/shared-database fallback. */
export function ciContainerId(environment, platform) {
  const id = environment.IDX_TEST_SERVICE_CONTAINER;
  if (!id) {
    if (environment.GITHUB_ACTIONS === "true") fail("idx_test_ci_container_required");
    return undefined;
  }
  if (
    environment.CI !== "true" ||
    environment.GITHUB_ACTIONS !== "true" ||
    platform !== "linux" ||
    !hexId.test(id)
  )
    fail("idx_test_ci_context_invalid");
  return id;
}

function envValue(values, key, required = true) {
  const entries = values.filter((value) => typeof value === "string" && value.startsWith(`${key}=`));
  if ((required && entries.length !== 1) || (!required && entries.length > 1))
    fail("idx_test_ci_environment_invalid");
  return entries[0]?.slice(key.length + 1);
}
function loopbackMapping(ports) {
  if (!object(ports) || Object.keys(ports).length !== 1 || !Array.isArray(ports["5432/tcp"])) return false;
  const bindings = ports["5432/tcp"];
  return (
    bindings.length === 1 &&
    object(bindings[0]) &&
    bindings[0].HostIp === "127.0.0.1" &&
    bindings[0].HostPort === "54434"
  );
}
function privateIpv4(value) {
  if (typeof value !== "string" || isIP(value) !== 4) return false;
  const bytes = value.split(".").map(Number);
  return (
    bytes[0] === 10 ||
    (bytes[0] === 172 && bytes[1] >= 16 && bytes[1] <= 31) ||
    (bytes[0] === 192 && bytes[1] === 168)
  );
}

/** Validate daemon inspection metadata without executing commands or inspecting any services. */
export function verifyCiContainerOwnership(container, id, environment, platform) {
  if (ciContainerId(environment, platform) !== id || !hexId.test(id)) fail("idx_test_ci_identity_invalid");
  if (
    !object(container) ||
    container.Id !== id ||
    typeof container.Name !== "string" ||
    !/^\/[a-zA-Z0-9_.-]+$/.test(container.Name)
  )
    fail("idx_test_ci_identity_invalid");
  const state = container.State;
  if (
    !object(state) ||
    state.Status !== "running" ||
    state.Running !== true ||
    state.Paused !== false ||
    state.Restarting !== false ||
    !Number.isInteger(state.Pid) ||
    state.Pid < 1 ||
    state.Health?.Status !== "healthy" ||
    typeof state.StartedAt !== "string" ||
    !Number.isFinite(Date.parse(state.StartedAt))
  )
    fail("idx_test_ci_state_invalid");
  const config = container.Config;
  if (
    !object(config) ||
    config.Image !== containerImage ||
    typeof container.Image !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(container.Image) ||
    !Array.isArray(config.Cmd) ||
    config.Cmd.length !== 1 ||
    config.Cmd[0] !== "postgres" ||
    !Array.isArray(config.Env) ||
    !config.Env.every((entry) => typeof entry === "string")
  )
    fail("idx_test_ci_image_invalid");
  if (
    envValue(config.Env, "PGDATA") !== dataDirectory ||
    envValue(config.Env, "POSTGRES_DB") !== "postgres" ||
    envValue(config.Env, "POSTGRES_PASSWORD") !== "idx-migration-only" ||
    ![undefined, "postgres"].includes(envValue(config.Env, "POSTGRES_USER", false)) ||
    ![undefined, "5432"].includes(envValue(config.Env, "PGPORT", false))
  )
    fail("idx_test_ci_environment_invalid");
  const host = container.HostConfig;
  if (
    !object(host) ||
    host.Privileged !== false ||
    host.PublishAllPorts !== false ||
    !empty(host.Binds) ||
    !empty(host.Mounts) ||
    !empty(host.VolumesFrom) ||
    !empty(host.CapAdd)
  )
    fail("idx_test_ci_host_config_invalid");
  if (!loopbackMapping(host.PortBindings) || !loopbackMapping(container.NetworkSettings?.Ports))
    fail("idx_test_ci_port_invalid");
  if (!Array.isArray(container.Mounts) || container.Mounts.length !== 1) fail("idx_test_ci_mount_invalid");
  const mount = container.Mounts[0];
  if (
    !object(mount) ||
    mount.Type !== "volume" ||
    mount.Driver !== "local" ||
    !hexId.test(mount.Name ?? "") ||
    mount.Destination !== dataDirectory ||
    mount.Source !== `/var/lib/docker/volumes/${mount.Name}/_data` ||
    mount.RW !== true
  )
    fail("idx_test_ci_mount_invalid");
  const networks = container.NetworkSettings?.Networks;
  if (
    !object(networks) ||
    Object.keys(networks).length !== 1 ||
    typeof host.NetworkMode !== "string" ||
    !/^github_network_[a-f0-9]{32}$/.test(host.NetworkMode) ||
    !Object.hasOwn(networks, host.NetworkMode)
  )
    fail("idx_test_ci_network_invalid");
  const network = networks[host.NetworkMode];
  if (
    !object(network) ||
    !hexId.test(network.NetworkID ?? "") ||
    !privateIpv4(network.IPAddress) ||
    (network.GlobalIPv6Address !== undefined && network.GlobalIPv6Address !== "") ||
    !Array.isArray(network.Aliases) ||
    !network.Aliases.includes("idx-postgres")
  )
    fail("idx_test_ci_network_invalid");
  return Object.freeze({
    containerId: id,
    containerName: container.Name.slice(1),
    imageId: container.Image,
    networkId: network.NetworkID,
    networkName: host.NetworkMode,
    networkAddress: network.IPAddress,
    volumeName: mount.Name,
    dataDirectory,
    hostPort: 54434,
    internalPort: 5432,
    startedAt: state.StartedAt,
  });
}

export function verifyCiImageAndNetwork(ownership, image, network) {
  if (
    !object(image) ||
    image.Id !== ownership.imageId ||
    !Array.isArray(image.RepoTags) ||
    !image.RepoTags.includes(containerImage)
  )
    fail("idx_test_ci_actual_image_invalid");
  if (
    !object(network) ||
    network.Id !== ownership.networkId ||
    network.Name !== ownership.networkName ||
    network.Driver !== "bridge" ||
    network.Scope !== "local" ||
    network.EnableIPv6 !== false ||
    !object(network.Containers)
  )
    fail("idx_test_ci_actual_network_invalid");
  const endpoint = network.Containers[ownership.containerId];
  if (
    !object(endpoint) ||
    endpoint.Name !== ownership.containerName ||
    typeof endpoint.IPv4Address !== "string" ||
    endpoint.IPv4Address.split("/")[0] !== ownership.networkAddress ||
    (endpoint.IPv6Address !== undefined && endpoint.IPv6Address !== "")
  )
    fail("idx_test_ci_actual_endpoint_invalid");
}

export function verifyCiDatabaseTarget(ownership, actual, postgisAvailable) {
  if (
    !object(actual) ||
    actual.directory !== ownership.dataDirectory ||
    String(actual.port) !== String(ownership.internalPort) ||
    actual.database !== "postgres" ||
    actual.current_user !== "postgres" ||
    actual.session_user !== "postgres"
  )
    fail("idx_test_ci_database_target_invalid");
  if (postgisAvailable !== true) fail("idx_test_postgis_unavailable");
}
