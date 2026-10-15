import { describe, expect, it } from "vitest";
import manifest from "../../apps/web/app/manifest";

describe("PWA manifest", () => {
  const m = manifest();

  it("has required name and short_name", () => {
    expect(m.name).toBeTruthy();
    expect(m.short_name).toBeTruthy();
    expect(m.short_name!.length).toBeLessThanOrEqual(12);
  });

  it("has standalone display mode", () => {
    expect(m.display).toBe("standalone");
  });

  it("starts at dashboard", () => {
    expect(m.start_url).toBe("/dashboard");
  });

  it("has scope covering the whole app", () => {
    expect(m.scope).toBe("/");
  });

  it("includes required icon sizes", () => {
    const sizes = m.icons!.map((i) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
  });

  it("includes a maskable icon", () => {
    const maskable = m.icons!.find((i) => i.purpose === "maskable");
    expect(maskable).toBeDefined();
    expect(maskable!.sizes).toBe("512x512");
  });

  it("has theme and background colors", () => {
    expect(m.theme_color).toBeTruthy();
    expect(m.background_color).toBeTruthy();
  });

  it("has a stable app id", () => {
    expect(m.id).toBe("/workspace");
  });
});
