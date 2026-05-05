import { describe, it, expect } from "bun:test";
import { compile, compileEffectful, CompileError } from "./jit.ts";

describe("compileEffectful — Phase 1: perform", () => {
  it("compile() still throws CompileError for perform", () => {
    expect(() => compile(["perform", "IO", 0])).toThrow(CompileError);
  });

  it("perform with compileEffectful: generator yields the effect", () => {
    const fn = compileEffectful(["perform", "IO", 42]);
    const gen = fn({});
    const step = gen.next();
    expect(step.done).toBe(false);
    expect((step.value as any).tag).toBe("IO");
    expect((step.value as any).payload).toBe(42n); // Marinada int
  });

  it("pure expression in compileEffectful: generator returns value directly", () => {
    const fn = compileEffectful(["+", 3, 4]);
    const gen = fn({});
    const step = gen.next();
    expect(step.done).toBe(true);
    expect(step.value).toBe(7n);
  });

  it("perform with env variable as payload", () => {
    const fn = compileEffectful(["perform", "Tag", "x"]);
    const gen = fn({ x: 10n });
    const step = gen.next();
    expect(step.done).toBe(false);
    expect((step.value as any).tag).toBe("Tag");
    expect((step.value as any).payload).toBe(10n);
  });
});
