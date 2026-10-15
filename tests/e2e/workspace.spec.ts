import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const LEAD_ACKNOWLEDGED = "Lead creation acknowledged. Current lists are read separately.";

async function signIn(page: Page, identity: "owner" | "agent" = "agent") {
  await page.goto("/dashboard");
  await page.getByRole("button", { name: `Sign in as ${identity} (synthetic)`, exact: true }).click();
  await expect(page.getByRole("button", { name: "Add lead", exact: true })).toBeEnabled();
  await expect(page.getByText("Synthetic environment", { exact: true })).toBeVisible();
}

async function navigate(page: Page, name: "Contacts" | "Pipeline" | "Tasks" | "Settings") {
  // A historical command acknowledgement can precede the independent current read.
  // Navigate only once the shell's existing busy/draft guard has released.
  await expect(page.getByRole("combobox", { name: "Workspace scope", exact: true })).toBeEnabled();
  // Nav links can carry a count badge (e.g. "Tasks 1") in their accessible name.
  const link = page.getByRole("link", { name: new RegExp(`^${name}(?: \\d+)?$`) }).filter({ visible: true });
  await link.click();
  await expect(page.getByRole("heading", { name, exact: true, level: 1 })).toBeVisible();
}

async function checkAccessibility(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
}

async function checkResponsiveWidth(page: Page) {
  const widths = await page.evaluate(() => ({
    content: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(widths.content).toBeLessThanOrEqual(widths.viewport + 1);
}

test("browser and 360px: interrupted capture reconciles, then task and keyboard pipeline commands work", async ({
  page,
}) => {
  await signIn(page);
  const name = `Synthetic browser ${randomUUID()}`;
  const taskTitle = `Synthetic follow-up ${randomUUID()}`;
  const idempotencyKeys: string[] = [];
  let interrupted = false;
  await page.route("**/api/v1/orgs/*/leads", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    idempotencyKeys.push(route.request().headers()["idempotency-key"]);
    if (!interrupted) {
      interrupted = true;
      const accepted = await route.fetch();
      expect(accepted.status()).toBe(201);
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Add lead", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Add a lead" });
  await editor.getByLabel("Full name", { exact: true }).fill(name);
  await editor.getByLabel("Email", { exact: true }).fill(`${randomUUID()}@example.invalid`);
  // A label wrapping a <select> includes its option text, so address the field by name.
  await editor.locator('select[name="intent"]').selectOption("buyer");
  await editor.locator('select[name="sourceId"]').selectOption({ label: "Synthetic website inquiry" });
  await editor.getByLabel("Timeline (optional)", { exact: true }).fill("Within 3 months");
  await checkResponsiveWidth(page);
  await checkAccessibility(page);
  await editor.getByRole("button", { name: "Save lead", exact: true }).click();
  // ADR-040: an interrupted step is unconfirmed; only the original step can be reconciled.
  await expect(editor.getByRole("alert")).toContainText("Creation is unconfirmed");
  await expect(page.getByText(LEAD_ACKNOWLEDGED, { exact: true })).not.toBeVisible();
  await editor.getByRole("button", { name: "Reconcile original step", exact: true }).click();
  await expect(page.getByText(LEAD_ACKNOWLEDGED, { exact: true })).toBeVisible();
  expect(idempotencyKeys).toHaveLength(2);
  expect(idempotencyKeys[0]).toBeTruthy();
  expect(idempotencyKeys[0]).toBe(idempotencyKeys[1]);
  await navigate(page, "Contacts");
  // ADR-038: name search is a server query submitted explicitly.
  await page.getByLabel("Contact name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Search names", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toHaveCount(1);
  await navigate(page, "Tasks");
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  const taskEditor = page.getByRole("dialog", { name: "Add a task" });
  await taskEditor.getByLabel("Title", { exact: true }).fill(taskTitle);
  await taskEditor.getByLabel("Due date and time", { exact: false }).fill("2026-11-01T09:00");
  await taskEditor.locator('select[name="leadId"]').selectOption({ label: name });
  await taskEditor.getByRole("button", { name: "Save task", exact: true }).click();
  await expect(
    page.getByText(/^Task creation acknowledged\. Current tasks are read separately/),
  ).toBeVisible();
  await page.getByRole("button", { name: `Complete task: ${taskTitle}`, exact: true }).click();
  await expect(page.getByText(/^Task update acknowledged\./)).toBeVisible();
  await page.getByRole("button", { name: "Completed", exact: true }).click();
  await expect(page.getByRole("button", { name: `Complete task: ${taskTitle}`, exact: true })).toBeDisabled();
  await navigate(page, "Pipeline");
  const stage = page.getByLabel(`Stage for ${name}`, { exact: true });
  await stage.selectOption({ label: "Attempted Contact" });
  await expect(
    page.getByText("Stage transition acknowledged. Current records are read separately.", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("heading", { name: "Attempted Contact", exact: true })
      .locator("..")
      .locator("..")
      .getByRole("link", { name, exact: true }),
  ).toBeVisible();
  await checkResponsiveWidth(page);
  await checkAccessibility(page);
});

test("organization switch removes earlier records on mobile and desktop", async ({ page }) => {
  await signIn(page, "owner");
  const session = await (await page.request.get("/api/v1/session")).json();
  const firstOrg = session.activeOrgId;
  const secondOrg = session.organizations.find(
    (organization: { id: string }) => organization.id !== firstOrg,
  ).id;
  const contactsResponse = await page.request.get(`/api/v1/orgs/${firstOrg}/contacts?limit=100`);
  expect(contactsResponse.status()).toBe(200);
  const firstContacts = await contactsResponse.json();
  expect(firstContacts.items.length).toBeGreaterThan(0);
  const name = firstContacts.items[0].displayName;
  await navigate(page, "Contacts");
  // The API read above uses current authorized scope; My workspace adds a member filter.
  await page.getByRole("combobox", { name: "Workspace scope", exact: true }).selectOption("authorized");
  await page.getByLabel("Contact name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Search names", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  // The sidebar switcher is "Organization"; the mobile layout shows "Mobile organization".
  await page
    .getByRole("combobox", { name: /^(?:Mobile )?organization$/i })
    .filter({ visible: true })
    .selectOption(secondOrg);
  await expect(
    page.getByText("Organization switched. Session and access verified.", { exact: true }),
  ).toBeVisible();
  const currentSessionResponse = await page.request.get("/api/v1/session");
  expect(currentSessionResponse.status()).toBe(200);
  expect((await currentSessionResponse.json()).activeOrgId).toBe(secondOrg);
  await expect(page.getByRole("heading", { name, exact: true })).not.toBeVisible();
  const denied = await page.request.get(`/api/v1/orgs/${firstOrg}/leads`);
  expect(denied.status()).toBe(403);
  await checkResponsiveWidth(page);
});

test("offline draft stays in memory, saving is disabled, and reconnect permits explicit save", async ({
  page,
  context,
}) => {
  await signIn(page);
  const draftName = `Synthetic unsaved ${randomUUID()}`;
  await page.getByRole("button", { name: "Add lead", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Add a lead" });
  await editor.getByLabel("Full name", { exact: true }).fill(draftName);
  await editor.locator('select[name="sourceId"]').selectOption({ label: "Synthetic website inquiry" });
  await context.setOffline(true);
  // Private fields are withheld while offline and no request can be sent.
  await expect(
    editor.getByText("Lead capture fields are hidden while offline or this view is inactive.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(editor.getByLabel("Full name", { exact: true })).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "Save lead", exact: true })).toHaveCount(0);
  await context.setOffline(false);
  await expect(editor.getByRole("button", { name: "Save lead", exact: true })).toBeEnabled();
  await expect(editor.getByLabel("Full name", { exact: true })).toHaveValue(draftName);
  await editor.getByRole("button", { name: "Save lead", exact: true }).click();
  await expect(page.getByText(LEAD_ACKNOWLEDGED, { exact: true })).toBeVisible();
});

test("manifest/icons and safe caches support a generic offline shell after logout", async ({
  page,
  context,
}) => {
  const manifestResponse = await page.request.get("/manifest.webmanifest");
  expect(manifestResponse.status()).toBe(200);
  const manifest = await manifestResponse.json();
  expect(manifest).toMatchObject({
    id: "/workspace",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
  });
  expect(manifest.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual(
    expect.arrayContaining(["192x192", "512x512"]),
  );
  for (const icon of manifest.icons) {
    const response = await page.request.get(icon.src);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("image/png");
    const body = await response.body();
    expect(body.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  }
  await signIn(page);
  await navigate(page, "Contacts");
  // Earlier capture cases create member-owned fixtures; wait for actual current private rows.
  // An empty pre-read heading list would make the cache privacy assertion vacuous.
  const contacts = page.getByRole("list", { name: "Loaded contact search results", exact: true });
  await expect(contacts).toBeVisible();
  const privateNames = await contacts.getByRole("heading", { level: 3 }).allTextContents();
  expect(privateNames.length).toBeGreaterThan(0);
  await navigate(page, "Settings");
  await expect(page.getByText("Add to Home Screen", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable push", exact: true })).toHaveCount(0);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect.poll(async () => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  const storage = await page.evaluate(async () => {
    const entries: { url: string; body: string }[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        entries.push({ url: request.url, body: await response!.text() });
      }
    }
    return { entries, databases: await indexedDB.databases() };
  });
  expect(storage.entries.length).toBeGreaterThan(0);
  for (const entry of storage.entries) {
    const url = new URL(entry.url);
    expect(url.search).toBe("");
    expect(url.pathname).toMatch(
      /^(?:\/offline\.html|\/icons\/[^/]+\.png|\/_next\/static\/.+[a-f0-9]{8,}.+\.(?:js|css|woff2?))$/,
    );
    for (const name of privateNames) expect(entry.body).not.toContain(name);
  }
  expect(storage.databases).toEqual([]);
  // The sidebar has an icon button and the settings panel a text button; both sign out.
  await page.getByRole("button", { name: "Sign out", exact: true }).filter({ visible: true }).first().click();
  await expect(page.getByRole("button", { name: "Sign in as agent (synthetic)", exact: true })).toBeVisible();
  await context.setOffline(true);
  // setOffline alone leaves the service worker's own fetches connected.
  await context.route("**/*", (route) => route.abort("internetdisconnected"));
  await page.goto("/contacts");
  await expect(page.getByRole("heading", { name: "You’re offline", exact: true })).toBeVisible();
  for (const name of privateNames) await expect(page.getByText(name, { exact: true })).not.toBeVisible();
  await checkAccessibility(page);
});

test("a real waiting worker preserves dirty content until the user accepts a safe update", async ({
  page,
}) => {
  await signIn(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect.poll(async () => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await page.getByRole("button", { name: "Add lead", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Add a lead" });
  const draft = `Synthetic update draft ${randomUUID()}`;
  await editor.getByLabel("Full name", { exact: true }).fill(draft);
  // A distinct script URL creates a genuine waiting worker without modifying shared source files.
  await page.evaluate(async () => {
    await navigator.serviceWorker.register(`/sw.js?acceptance-update=${Date.now()}`, { scope: "/" });
  });
  await expect(
    page.getByRole("button", { name: "Update app", exact: true, includeHidden: true }),
  ).toBeDisabled();
  await expect(editor.getByLabel("Full name", { exact: true })).toHaveValue(draft);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Discard");
    await dialog.accept();
  });
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  const update = page.getByRole("button", { name: "Update app", exact: true });
  await expect(update).toBeEnabled();
  await update.click();
  await expect(page.getByRole("button", { name: "Add lead", exact: true })).toBeEnabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("login and workspace support keyboard access and pass the implemented accessibility states", async ({
  page,
}) => {
  await page.goto("/dashboard");
  await checkAccessibility(page);
  await page.getByRole("button", { name: "Sign in as agent (synthetic)", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Add lead", exact: true })).toBeEnabled();
  await checkAccessibility(page);
  await page.getByRole("button", { name: "Add lead", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Add a lead" })).toBeVisible();
  await page.keyboard.press("Tab");
  const active = await page.locator(":focus").evaluate((element) => element.closest("dialog") !== null);
  expect(active).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await navigate(page, "Tasks");
  await checkAccessibility(page);
  await navigate(page, "Settings");
  await checkAccessibility(page);
});
