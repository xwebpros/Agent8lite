import { randomUUID } from "node:crypto";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { expect } from "vitest";
import contract from "../../packages/contracts/openapi.json";
import type { components } from "../../packages/contracts/generated/api";

export type Schemas = components["schemas"];
export const apiOrigin = process.env.TEST_API_ORIGIN ?? "http://127.0.0.1:3001";
const validators = new Map<string, ValidateFunction>();
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: "contract", components: contract.components });

export function assertContract<T extends keyof Schemas>(
  schema: T,
  value: unknown,
): asserts value is Schemas[T] {
  let validate = validators.get(schema);
  if (!validate) {
    validate = ajv.compile({ $ref: `contract#/components/schemas/${schema}` });
    validators.set(schema, validate);
  }
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}

export class ApiSession {
  cookie = "";
  csrf = "";
  memberId = "";
  session!: Schemas["Session"];

  async signIn(identity: "owner" | "agent" = "owner") {
    const response = await this.request("/dev/session", {
      method: "POST",
      body: JSON.stringify({ identity }),
    });
    expect(response.status).toBe(200);
    this.cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
    this.csrf = response.headers.get("x-csrf-token") ?? "";
    this.memberId = response.headers.get("x-member-id") ?? "";
    const session = await response.json();
    assertContract("Session", session);
    this.session = session;
    expect(this.cookie).not.toBe("");
    expect(this.csrf).not.toBe("");
    expect(this.memberId).not.toBe("");
    return this;
  }

  get orgId() {
    if (!this.session.activeOrgId) throw new Error("Synthetic session has no active organization");
    return this.session.activeOrgId;
  }

  request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    if (!headers.has("origin")) headers.set("origin", process.env.TEST_WEB_ORIGIN ?? "http://localhost:3000");
    if (this.cookie) headers.set("cookie", this.cookie);
    return fetch(`${apiOrigin}${path}`, { ...init, headers });
  }

  command(
    path: string,
    body: unknown,
    options: { method?: string; key?: string; revision?: string; csrf?: string } = {},
  ) {
    const headers: Record<string, string> = {
      "idempotency-key": options.key ?? randomUUID(),
      "x-csrf-token": options.csrf ?? this.csrf,
    };
    if (options.revision) headers["if-match"] = options.revision;
    return this.request(path, { method: options.method ?? "POST", headers, body: JSON.stringify(body) });
  }

  async switchOrganization(orgId: string) {
    const response = await this.command("/dev/session/organization", { organizationId: orgId });
    if (response.status === 200) {
      this.csrf = response.headers.get("x-csrf-token") ?? this.csrf;
      this.memberId = response.headers.get("x-member-id") ?? this.memberId;
      const session = await response.json();
      assertContract("Session", session);
      this.session = session;
    }
    return response;
  }

  async read<T extends keyof Schemas>(path: string, schema: T, expectedStatus = 200) {
    const response = await this.request(path);
    expect(response.status).toBe(expectedStatus);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json();
    assertContract(schema, body);
    return { response, body };
  }
}

export async function assertProblem(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  const body = await response.json();
  assertContract("Problem", body);
  expect(body.status).toBe(status);
  return body;
}
