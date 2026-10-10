import { expect, it, vi } from "vitest";
import { probeTrestleAccess } from "./access-probe";

const config = {
  organizationId: "fixture-org",
  feedId: "fixture-feed",
  productId: "fixture-product",
  mlsName: "Fixture MLS",
  feedType: "IDX",
  connectionState: "approved",
  brokerAuthorization: "approved",
  endpoints: {
    tokenUrl: "https://api.cotality.com/trestle/oidc/connect/token",
    odataBaseUrl: "https://api.cotality.com/trestle/odata/",
  },
};
const environment = {
  TRESTLE_ACCESS_TEST_ENABLED: "true",
  TRESTLE_CLIENT_ID: "fixture-id",
  TRESTLE_CLIENT_SECRET: "fixture-secret",
  TRESTLE_CREDENTIAL_VERSION: "fixture-v1",
  TRESTLE_CREDENTIAL_EXPIRES_AT: "2027-01-01T00:00:00Z",
};
it.each([
  [false, "true"],
  [true, "false"],
  [true, undefined],
])("does nothing unless both access gates are enabled (%s, %s)", async (enabled, flag) => {
  const readConfig = vi.fn();
  const fetch = vi.fn();
  expect(
    await probeTrestleAccess({
      enabled: enabled as boolean,
      environment: { TRESTLE_ACCESS_TEST_ENABLED: flag as string | undefined },
      readConfig,
      fetch,
    }),
  ).toMatchObject({ state: "disabled" });
  expect(readConfig).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it("only authenticates and reads metadata, printing its size and hash", async () => {
  const fetch = vi.fn(async (input: string | URL | Request) =>
    String(input).endsWith("/token")
      ? new Response(
          JSON.stringify({ token_type: "Bearer", access_token: "fixture-token", expires_in: 3600 }),
        )
      : new Response("<Edmx></Edmx>"),
  );
  const result = await probeTrestleAccess({
    enabled: true,
    environment,
    readConfig: async () => config,
    fetch,
    now: () => new Date("2026-10-10T00:00:00Z"),
  });
  expect(result).toMatchObject({ state: "accessible", protocol: "reso-web-api", metadataBytes: 13 });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(String(fetch.mock.calls[1][0]).endsWith("/$metadata")).toBe(true);
  expect(JSON.stringify(result)).not.toContain("fixture-secret");
  expect(JSON.stringify(result)).not.toContain("fixture-token");
  expect(JSON.stringify(result)).not.toContain("Edmx");
});
it("refuses pending connection approval without using credentials", async () => {
  const fetch = vi.fn();
  await expect(
    probeTrestleAccess({
      enabled: true,
      environment,
      readConfig: async () => ({ ...config, connectionState: "pending" }),
      fetch,
    }),
  ).rejects.toMatchObject({ code: "TRESTLE_FEED_NOT_AUTHORIZED" });
  expect(fetch).not.toHaveBeenCalled();
});
it("rejects placeholder account configuration", async () => {
  const fetch = vi.fn();
  await expect(
    probeTrestleAccess({
      enabled: true,
      environment,
      readConfig: async () => ({ ...config, feedId: "REPLACE_FEED_ID" }),
      fetch,
    }),
  ).rejects.toMatchObject({ code: "TRESTLE_ACCESS_CONFIG_INVALID" });
  expect(fetch).not.toHaveBeenCalled();
});
