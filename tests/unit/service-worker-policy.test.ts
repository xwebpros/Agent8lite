import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const origin = "http://localhost:3000";
const script = readFileSync(resolve("apps/web/public/sw.js"), "utf8");
const offlineShell = readFileSync(resolve("apps/web/public/offline.html"), "utf8");
type StoredCache = Map<string, Response>;
type TestEvent = { request?: { url: string; method: string; mode: string }; data?: { type: string } };

function workerHarness() {
  const stores = new Map<string, StoredCache>();
  const listeners = new Map<string, (event: unknown) => void>();
  const installedAssets: string[] = [];
  const skipWaiting = vi.fn();
  const claim = vi.fn(async () => {});
  const network = vi.fn(async () => {
    const response = new Response("Approved static content", { status: 200 });
    Object.defineProperty(response, "type", { value: "basic" });
    return response;
  });
  const key = (input: string | { url: string }) =>
    new URL(typeof input === "string" ? input : input.url, origin).href;
  const caches = {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        async addAll(paths: string[]) {
          installedAssets.push(...paths);
          for (const path of paths)
            store.set(
              key(path),
              new Response(path === "/offline.html" ? offlineShell : "Original public icon"),
            );
        },
        async match(request: string | { url: string }) {
          return store.get(key(request));
        },
        async put(request: string | { url: string }, response: Response) {
          store.set(key(request), response);
        },
      };
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name: string) {
      return stores.delete(name);
    },
    async match(request: string | { url: string }) {
      for (const store of stores.values()) if (store.has(key(request))) return store.get(key(request));
      return undefined;
    },
  };
  runInNewContext(script, {
    URL,
    Response,
    caches,
    fetch: network,
    self: {
      location: { origin },
      addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
      skipWaiting,
      clients: { claim },
    },
  });
  async function dispatch(type: string, details: TestEvent = {}) {
    let waiting: Promise<unknown> | undefined;
    let response: Promise<Response> | undefined;
    const listener = listeners.get(type);
    if (!listener) throw new Error(`Missing service-worker handler: ${type}`);
    listener({
      ...details,
      waitUntil: (promise: Promise<unknown>) => {
        waiting = promise;
      },
      respondWith: (promise: Promise<Response>) => {
        response = promise;
      },
    });
    if (waiting) await waiting;
    return response ? await response : undefined;
  }
  return { stores, installedAssets, skipWaiting, claim, network, dispatch };
}

describe("MOD-K unit policy — isolated service-worker handlers, without browser acceptance claims", () => {
  it("installs only a generic offline shell and original icons; activation removes obsolete static versions", async () => {
    const harness = workerHarness();
    harness.stores.set("estate-static-obsolete", new Map());
    await harness.dispatch("install");
    expect(harness.installedAssets).toEqual(
      expect.arrayContaining([
        "/offline.html",
        "/icons/app-192.png",
        "/icons/app-512.png",
        "/icons/app-maskable-512.png",
        "/icons/apple-touch-icon.png",
      ]),
    );
    expect(harness.installedAssets).toHaveLength(5);
    expect(harness.skipWaiting).not.toHaveBeenCalled();
    await harness.dispatch("activate");
    expect(harness.stores.has("estate-static-obsolete")).toBe(false);
    expect(harness.claim).toHaveBeenCalledOnce();
  });

  it("persists hashed same-origin static assets and serves the cache without another network call", async () => {
    const harness = workerHarness();
    const request = { url: `${origin}/_next/static/chunks/abcdef123456.js`, method: "GET", mode: "cors" };
    expect(await harness.dispatch("fetch", { request })).toBeInstanceOf(Response);
    expect(harness.network).toHaveBeenCalledOnce();
    expect(await harness.dispatch("fetch", { request })).toBeInstanceOf(Response);
    expect(harness.network).toHaveBeenCalledOnce();
    expect([...harness.stores.values()].flatMap((store) => [...store.keys()])).toEqual([request.url]);
  });

  it.each([
    "/api/v1/session",
    "/api/v1/orgs/tenant/contacts",
    "/api/v1/orgs/tenant/billing",
    "/api/v1/orgs/tenant/ai/jobs",
    "/api/v1/orgs/tenant/listings",
    "/contacts?__rsc=personal",
    "/_next/static/chunks/unhashed.js",
    "/_next/static/chunks/abcdef123456.js?personal=true",
  ])("does not intercept or persist sensitive/unsupported GET content: %s", async (path) => {
    const harness = workerHarness();
    const response = await harness.dispatch("fetch", {
      request: { url: `${origin}${path}`, method: "GET", mode: "cors" },
    });
    expect(response).toBeUndefined();
    expect(harness.network).not.toHaveBeenCalled();
    expect(harness.stores.size).toBe(0);
  });

  it("never caches private successful navigation and uses the generic shell on network failure", async () => {
    const harness = workerHarness();
    await harness.dispatch("install");
    harness.network.mockResolvedValueOnce(new Response("Synthetic private contact name"));
    const request = { url: `${origin}/contacts`, method: "GET", mode: "navigate" };
    expect(await (await harness.dispatch("fetch", { request }))!.text()).toBe(
      "Synthetic private contact name",
    );
    const cacheUrls = [...harness.stores.values()].flatMap((store) => [...store.keys()]);
    expect(cacheUrls).not.toContain(request.url);
    harness.network.mockRejectedValueOnce(new Error("Synthetic offline"));
    const fallback = await harness.dispatch("fetch", { request });
    const body = await fallback!.text();
    expect(body).toBe(offlineShell);
    expect(body).not.toContain("Synthetic private contact name");
  });

  it("leaves mutations to the network and activates only after the explicit accepted-update message", async () => {
    const harness = workerHarness();
    expect(
      await harness.dispatch("fetch", {
        request: { url: `${origin}/api/v1/orgs/tenant/leads`, method: "POST", mode: "cors" },
      }),
    ).toBeUndefined();
    expect(harness.stores.size).toBe(0);
    await harness.dispatch("message", { data: { type: "UNKNOWN" } });
    expect(harness.skipWaiting).not.toHaveBeenCalled();
    await harness.dispatch("message", { data: { type: "ACTIVATE_UPDATE" } });
    expect(harness.skipWaiting).toHaveBeenCalledOnce();
  });
});
