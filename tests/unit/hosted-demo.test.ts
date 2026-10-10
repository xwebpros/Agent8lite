import { describe, expect, it } from "vitest";
import {
  createPreviewLimiter,
  createPreviewSession,
  demoSettings,
  previewCsrf,
  previewOriginAllowed,
  previewPasswordMatches,
  readPreviewForm,
  verifyPreviewCsrf,
  verifyPreviewSession,
} from "../../apps/web/lib/hosted-demo-access";
import {
  addDemoContact,
  changeDemoStage,
  sampleContacts,
  sampleMetrics,
  sampleTasks,
} from "../../apps/web/features/hosted-demo/model";

const env = {
  HOSTED_DEMO_ENABLED: "true",
  DEMO_ACCESS_PASSWORD: "fixture-preview-password",
  DEMO_SESSION_SECRET: "fixture-session-secret-at-least-thirty-two",
  WEB_ORIGIN: "https://demo.example.com",
};
const settings = demoSettings(env)!;
describe("isolated hosted preview access", () => {
  it.each([
    {},
    { ...env, HOSTED_DEMO_ENABLED: "false" },
    { ...env, DEMO_ACCESS_PASSWORD: "short" },
    { ...env, DEMO_SESSION_SECRET: "short" },
    { ...env, WEB_ORIGIN: "http://demo.example.com" },
    { ...env, WEB_ORIGIN: "https://user:password@demo.example.com" },
  ])("denies absent or invalid configuration", (configuration) =>
    expect(demoSettings(configuration)).toBeNull(),
  );
  it("uses secure hosted cookies but permits an explicit loopback HTTP smoke", () => {
    expect(settings.secure).toBe(true);
    expect(demoSettings({ ...env, WEB_ORIGIN: "http://127.0.0.1:43210" })?.secure).toBe(false);
  });
  it("accepts only the configured password", () => {
    expect(previewPasswordMatches(env.DEMO_ACCESS_PASSWORD, settings)).toBe(true);
    expect(previewPasswordMatches("", settings)).toBe(false);
    expect(previewPasswordMatches("x".repeat(400), settings)).toBe(false);
  });
  it("binds a unique cookie to the signing secret and one-hour lifetime", () => {
    const now = 1791600000000;
    const token = createPreviewSession(settings, now);
    expect(verifyPreviewSession(token, settings, now)).toBe(true);
    expect(verifyPreviewSession(token, settings, now + 3599999)).toBe(true);
    expect(verifyPreviewSession(token, settings, now + 3600000)).toBe(false);
    expect(verifyPreviewSession(token, settings, now - 1)).toBe(false);
    expect(
      verifyPreviewSession(token, { ...settings, secret: "another-signing-secret-with-more-than32" }, now),
    ).toBe(false);
    expect(createPreviewSession(settings, now)).not.toBe(token);
    expect(verifyPreviewSession(token.replace(/^\d/, "2"), settings, now)).toBe(false);
  });
  it.each([
    undefined,
    "",
    "garbage",
    "1.a.b",
    "0." + "a".repeat(32) + "." + "a".repeat(43),
    "9".repeat(17) + "." + "a".repeat(32) + "." + "a".repeat(43),
  ])("denies malformed sessions", (token) => expect(verifyPreviewSession(token, settings)).toBe(false));
  it("binds CSRF to the exact session", () => {
    const token = createPreviewSession(settings);
    const other = createPreviewSession(settings);
    expect(verifyPreviewCsrf(previewCsrf(token, settings), token, settings)).toBe(true);
    expect(verifyPreviewCsrf(previewCsrf(other, settings), token, settings)).toBe(false);
    expect(verifyPreviewCsrf(undefined, token, settings)).toBe(false);
  });
  it.each([
    {},
    { origin: "https://evil.example.com" },
    { origin: env.WEB_ORIGIN, "sec-fetch-site": "cross-site" },
  ])("denies cross-origin or absent origin", (headers) =>
    expect(
      previewOriginAllowed(
        new Request("http://localhost/demo/session", { headers: headers as Record<string, string> }),
        settings,
      ),
    ).toBe(false),
  );
  it("accepts the configured browser origin behind a private HTTP proxy", () =>
    expect(
      previewOriginAllowed(
        new Request("http://localhost/demo/session", {
          headers: { origin: env.WEB_ORIGIN, "sec-fetch-site": "same-origin" },
        }),
        settings,
      ),
    ).toBe(true));
  it("bounds attempts and opens the next window", () => {
    let now = 100;
    const allow = createPreviewLimiter(() => now);
    for (let attempt = 0; attempt < 10; attempt++) expect(allow()).toBe(true);
    expect(allow()).toBe(false);
    now += 60000;
    expect(allow()).toBe(true);
  });
  it("reads a single bounded field", async () => {
    const request = new Request("http://localhost/demo/session", {
      method: "POST",
      body: new URLSearchParams({ password: "fixture & preview" }),
    });
    await expect(readPreviewForm(request, "password")).resolves.toBe("fixture & preview");
  });
  it.each(["password=a&password=b", "password=a&extra=b", "csrf=wrong", "password=" + "a".repeat(2048)])(
    "denies duplicate, extra, wrong or oversized fields",
    async (body) => {
      const request = new Request("http://localhost/demo/session", {
        method: "POST",
        body,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      await expect(readPreviewForm(request, "password")).rejects.toThrow();
    },
  );
  it("denies another content type", async () => {
    await expect(
      readPreviewForm(
        new Request("http://localhost/demo/session", { method: "POST", body: "{}" }),
        "password",
      ),
    ).rejects.toThrow();
  });
});
describe("temporary preview fixture state", () => {
  it("each page/reset has independent fixture objects", () => {
    const first = sampleContacts();
    first[0].name = "Changed";
    expect(sampleContacts()[0].name).toBe("Alex Sample");
  });
  it("adds a bounded sample contact without mutating previous state", () => {
    const previous = sampleContacts();
    const next = addDemoContact(previous, " Casey Sample ", " Summerlin ", "preview-new");
    expect(previous).toHaveLength(4);
    expect(next).toHaveLength(5);
    expect(next[4]).toMatchObject({ name: "Casey Sample", interest: "Summerlin", stage: "New", value: 0 });
  });
  it.each(["", " ".repeat(3), "x".repeat(81)])("denies an invalid sample name", (name) =>
    expect(() => addDemoContact(sampleContacts(), name, "", "new")).toThrow(),
  );
  it("denies duplicates and capacity overflow", () => {
    expect(() => addDemoContact(sampleContacts(), "Sample", "", "sample-1")).toThrow();
    expect(() =>
      addDemoContact(
        Array.from({ length: 100 }, (_, id) => ({ ...sampleContacts()[0], id: String(id) })),
        "Sample",
        "",
        "new",
      ),
    ).toThrow();
  });
  it("updates pipeline stage and derives metrics from current preview", () => {
    const previous = sampleContacts();
    const next = changeDemoStage(previous, "sample-1", "Won");
    expect(previous[0].stage).toBe("Tour scheduled");
    expect(next[0].stage).toBe("Won");
    expect(sampleMetrics(next, sampleTasks())).toEqual({
      contacts: 4,
      opportunities: 3,
      pipeline: 1535000,
      tasks: 2,
    });
    expect(() => changeDemoStage(previous, "sample-1", "invalid" as never)).toThrow();
  });
});
