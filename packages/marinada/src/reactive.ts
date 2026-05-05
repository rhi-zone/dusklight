import { computed } from "@rhi-zone/rainbow";
import type { ReadonlySignal } from "@rhi-zone/rainbow";
import type { Expr } from "./types.ts";
import type { Value } from "./value.ts";
import { NULL, bool } from "./value.ts";
import { EMPTY_ENV } from "./env.ts";
import { evaluate } from "./evaluate.ts";
import { compile } from "./jit.ts";
import { freeVariables } from "./free-vars.ts";

/**
 * Minimal reactive signal shape — only what compileReactive actually needs.
 * Structurally compatible with @rhi-zone/rainbow's Signal and ReadonlySignal,
 * and with @dusklight/core's Signal, without requiring the `map` method.
 */
export type ReactiveSignal<A = unknown> = {
  get(): A;
  subscribe(fn: (value: A) => void): () => void;
};

/**
 * An environment mapping variable names to reactive signals.
 * Each signal's current value is substituted when the expression evaluates.
 */
export type ReactiveEnv = Record<string, ReactiveSignal>;

/**
 * A compiled reactive expression: given a ReactiveEnv, returns a derived
 * signal that re-evaluates whenever any signal it reads changes.
 */
export type ReactiveFn = (env: ReactiveEnv) => ReadonlySignal<unknown>;

/**
 * Compile a Marinada expression to a reactive function.
 *
 * Pure expressions: the JIT compiles once; a Proxy env auto-tracks exactly
 * which signals are read on each evaluation (dynamic deps, Vue-style).
 *
 * Effectful expressions (perform/handle): the interpreter runs on each
 * re-evaluation with a snapshot of all env signals. Over-tracking is
 * intentional — free-variable analysis for precision is a future optimisation.
 */
export function compileReactive(expr: Expr): ReactiveFn {
  if (containsEffects(expr)) return compileEffectful(expr);
  const jitFn = compile(expr);
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

// ---------------------------------------------------------------------------
// Effect detection
// ---------------------------------------------------------------------------

function containsEffects(expr: Expr): boolean {
  if (!Array.isArray(expr) || expr.length === 0) return false;
  const op = expr[0];
  if (op === "perform" || op === "handle") return true;
  return expr.slice(1).some((e) => containsEffects(e as Expr));
}

// ---------------------------------------------------------------------------
// Effectful path — interpreter with snapshot env
// ---------------------------------------------------------------------------

function compileEffectful(expr: Expr): ReactiveFn {
  const freeVars = freeVariables(expr);
  return (env: ReactiveEnv) =>
    computed(() => {
      // Only snapshot the signals for variables that are actually free in the
      // expression — precise dep tracking avoids spurious re-runs.
      const snapshot: Record<string, Value> = {};
      for (const key of freeVars) {
        const sig = env[key];
        if (sig !== undefined) snapshot[key] = jsToValue(sig.get());
      }
      const interpEnv = EMPTY_ENV.extend(snapshot);
      const result = evaluate(expr, interpEnv);
      if (!result.ok) {
        throw new Error(`[${result.error.code}] ${result.error.message}`);
      }
      return valueToJs(result.value);
    });
}

// ---------------------------------------------------------------------------
// JS ↔ Marinada Value conversion
// ---------------------------------------------------------------------------

function jsToValue(v: unknown): Value {
  if (v === null || v === undefined) return NULL;
  if (typeof v === "boolean") return bool(v);
  if (typeof v === "bigint") return { kind: "int", value: v };
  if (typeof v === "number") return { kind: "float", value: v };
  if (typeof v === "string") return { kind: "string", value: v };
  if (v instanceof Uint8Array) return { kind: "bytes", value: v };
  if (Array.isArray(v)) return { kind: "array", value: v.map(jsToValue) };
  if (typeof v === "object") {
    return {
      kind: "record",
      value: new Map(
        Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, jsToValue(val)]),
      ),
    };
  }
  throw new Error(`jsToValue: cannot convert ${typeof v}`);
}

function valueToJs(v: Value): unknown {
  switch (v.kind) {
    case "null":
      return null;
    case "bool":
      return v.value;
    case "int":
      return v.value;
    case "float":
      return v.value;
    case "string":
      return v.value;
    case "bytes":
      return v.value;
    case "array":
      return v.value.map(valueToJs);
    case "record":
      return Object.fromEntries([...v.value.entries()].map(([k, val]) => [k, valueToJs(val)]));
    default:
      return v; // fn, variant, cap, continuation — pass through opaque
  }
}
