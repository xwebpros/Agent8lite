import type { PoolClient } from "pg";
import { requireEntitlement } from "../../../../packages/auth/entitlements";
import { AccessError, type TenantContext } from "../../../../packages/db/tenant-transaction";
import {
  getNativeMockListing,
  MlsReadError,
  parseNativeListingQuery,
  requireListingRead,
  searchNativeMockListings,
} from "../../../../packages/mls";
import { isUuid } from "../../../../packages/mls/contracts";
import { validateSchema } from "../contract-validation";
import { NativeMockListingRepository } from "./repository";

export function assertNativeMockMode(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (
    !["development", "test"].includes(environment.APP_ENV ?? "") ||
    environment.DEV_AUTH_ENABLED !== "true" ||
    (environment.MLS_PROVIDER ?? "mock") !== "mock"
  )
    throw new AccessError(404, "synthetic_mls_disabled", "Synthetic property reads are disabled.");
}

/** Transaction-scoped read service; owns no sessions, routes, writes or provider network. */
export class NativeMockReadService {
  constructor(
    private readonly client: PoolClient,
    private readonly context: TenantContext,
    private readonly options: {
      signingKey: string;
      environment?: Readonly<Record<string, string | undefined>>;
    },
  ) {}

  private async read<T>(operation: () => Promise<T>): Promise<T> {
    assertNativeMockMode(this.options.environment);
    try {
      requireListingRead(this.context);
      await requireEntitlement(this.client, "mls.read");
      return await operation();
    } catch (error) {
      if (error instanceof MlsReadError) throw new AccessError(error.status, error.code, error.message);
      throw error;
    }
  }

  async list(query: unknown) {
    return this.read(async () => {
      const input = parseNativeListingQuery(query);
      const { snapshot, now } = await new NativeMockListingRepository(this.client).current();
      const body = searchNativeMockListings(snapshot, this.context, input, {
        now,
        signingKey: this.options.signingKey,
      });
      validateSchema("PageListing", body, true);
      return body;
    });
  }

  async detail(id: string, query: unknown = {}) {
    return this.read(async () => {
      if (
        !isUuid(id) ||
        !query ||
        typeof query !== "object" ||
        Array.isArray(query) ||
        Object.keys(query).length
      )
        throw new AccessError(422, "query_invalid", "The property detail request is invalid.");
      const { snapshot, now } = await new NativeMockListingRepository(this.client).current();
      const body = getNativeMockListing(snapshot, this.context, id, now);
      if (!body) throw new AccessError(404, "listing_unavailable", "The synthetic property is unavailable.");
      validateSchema("Listing", body, true);
      return body;
    });
  }
}
