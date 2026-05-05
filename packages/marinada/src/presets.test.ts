import { describe, it, expect } from "bun:test";
import { browserResolver, networkResolver } from "./presets.ts";

// --- browserResolver ---

describe("browserResolver", () => {
  it("resolves 'lib:std' and returns a Module", () => {
    const result = browserResolver("lib:std");
    expect(result).not.toBeNull();
    expect(typeof result).toBe("object");
  });

  it("lib:std module has expected std exports", () => {
    const result = browserResolver("lib:std");
    expect(result).not.toBeNull();
    const exports = result!.exports ?? [];
    expect(exports).toContain("map");
    expect(exports).toContain("filter");
    expect(exports).toContain("reduce");
  });

  it("returns null for 'local:./foo' (not handled)", () => {
    expect(browserResolver("local:./foo")).toBeNull();
  });

  it("returns null for https:// paths (not handled)", () => {
    expect(browserResolver("https://example.com/mod.json")).toBeNull();
  });

  it("returns null for unknown protocols", () => {
    expect(browserResolver("unknown:something")).toBeNull();
  });

  it("returns null for paths without a colon", () => {
    expect(browserResolver("nostd")).toBeNull();
  });
});

// --- networkResolver ---

describe("networkResolver", () => {
  it("resolves 'lib:std' synchronously (no await needed for cached)", async () => {
    const result = await networkResolver("lib:std");
    expect(result).not.toBeNull();
    expect(typeof result).toBe("object");
  });

  it("lib:std resolved via networkResolver has expected exports", async () => {
    const result = await networkResolver("lib:std");
    expect(result).not.toBeNull();
    const exports = result!.exports ?? [];
    expect(exports).toContain("map");
    expect(exports).toContain("filter");
    expect(exports).toContain("reduce");
  });

  it("returns null for 'unknown:...' protocol", async () => {
    expect(await networkResolver("unknown:something")).toBeNull();
  });

  it("returns null for paths without a colon", async () => {
    expect(await networkResolver("nostd")).toBeNull();
  });

  it("returns null for 'local:./foo' (not handled)", async () => {
    expect(await networkResolver("local:./foo")).toBeNull();
  });
});
