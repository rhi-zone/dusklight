import { computed } from "@rhi-zone/rainbow";
import type { ReadonlySignal } from "@rhi-zone/rainbow";
import type { Expr } from "./types.ts";
import { compile } from "./jit.ts";

/**
 * An environment mapping variable names to reactive signals.
 * Each signal's current value is substituted when the expression evaluates.
 */
export type ReactiveEnv = Record<string, ReadonlySignal<unknown>>;

/**
 * A compiled reactive expression: given a ReactiveEnv, returns a derived
 * signal that re-evaluates whenever any signal it reads changes.
 */
export type ReactiveFn = (env: ReactiveEnv) => ReadonlySignal<unknown>;

/**
 * Compile a Marinada expression to a reactive function.
 *
 * The JIT is run once at compile time. At call time, a Proxy env is passed to
 * the compiled function so that every env variable read inside it calls
 * signal.get() — auto-tracked by rainbow's computed(). Dynamic deps (e.g.
 * conditionally read variables) are updated on each re-evaluation, same as
 * Vue's computed model.
 *
 * Expressions containing `perform` or `handle` still throw CompileError —
 * effect-aware reactive compilation is Phase 2.
 */
export function compileReactive(expr: Expr): ReactiveFn {
  const jitFn = compile(expr); // throws CompileError for perform/handle
  return (env: ReactiveEnv) =>
    computed(() => {
      const proxy = new Proxy({} as Record<string, unknown>, {
        get(_, key: string) {
          return env[key]?.get();
        },
      });
      return jitFn(proxy);
    });
}
