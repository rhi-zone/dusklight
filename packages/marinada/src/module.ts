import type { Expr, Module } from "./types.ts";
import { evaluate, EMPTY_ENV } from "./evaluate.ts";
import type { EvalResult } from "./evaluate.ts";
import type { Value } from "./value.ts";
import { NULL } from "./value.ts";
import { Env } from "./env.ts";
import { typecheckModule } from "./typecheck.ts";
import type { TypecheckResult } from "./typecheck.ts";
import { STD_BINDINGS } from "./std.ts";

export type { EvalResult, TypecheckResult };

/**
 * Resolves a non-`lib:std` module import to its `Module` definition. Returns
 * `null` when the host cannot resolve the given path. The resolver is called
 * lazily during `evaluateModule` / `typecheckModule` and is responsible for
 * any caching, IO, or scheme handling (`local:`, `https:`, custom `lib:`...).
 */
export type ModuleResolver = (from: string) => Module | null;

export type EvaluateModuleOptions = {
  resolver?: ModuleResolver;
};

export type TypecheckModuleOptions = {
  resolver?: ModuleResolver;
};

// ---------------------------------------------------------------------------
// evaluateModule
// ---------------------------------------------------------------------------

/** Result of evaluating a resolved module: the main result plus its exports. */
type ModuleEvalExports = {
  result: EvalResult;
  exports: Map<string, Value>;
};

function evalErr(code: string, message: string): EvalResult {
  return { ok: false, error: { code, path: [], message } };
}

/**
 * Evaluate a module fully and extract values for each name listed in
 * `module.exports`. Uses let/letrec peeling on `module.main`: we walk the
 * outermost let/letrec layers, evaluating each binding in sequence and
 * recording values for names listed in `module.exports`. The final inner
 * body's result is returned as `result`.
 */
function evaluateModuleExports(
  module: Module,
  opts: EvaluateModuleOptions | undefined,
  cache: Map<string, ModuleEvalExports>,
): ModuleEvalExports {
  // Build the import env first.
  let env = EMPTY_ENV;
  for (const imp of module.imports ?? []) {
    if (imp.from === "lib:std") {
      const bindings: Record<string, Value> = {};
      for (const name of imp.import) {
        const binding = STD_BINDINGS.find((b) => b.name === name);
        if (binding === undefined) continue;
        const r = evaluate(binding.expr, EMPTY_ENV);
        if (!r.ok) return { result: r, exports: new Map() };
        bindings[name] = r.value;
      }
      env = env.extend(bindings);
      continue;
    }

    const resolver = opts?.resolver;
    if (resolver === undefined) continue; // backward compat — silently skip

    let resolved = cache.get(imp.from);
    if (resolved === undefined) {
      const mod = resolver(imp.from);
      if (mod === null) {
        return {
          result: evalErr("MODULE_NOT_FOUND", `module not found: ${imp.from}`),
          exports: new Map(),
        };
      }
      resolved = evaluateModuleExports(mod, opts, cache);
      cache.set(imp.from, resolved);
      if (!resolved.result.ok) return resolved;
    } else if (!resolved.result.ok) {
      return resolved;
    }

    const importBindings: Record<string, Value> = {};
    for (const name of imp.import) {
      if (!resolved.exports.has(name)) {
        return {
          result: evalErr("UNDEFINED_EXPORT", `module ${imp.from} does not export "${name}"`),
          exports: new Map(),
        };
      }
      importBindings[name] = resolved.exports.get(name) as Value;
    }
    env = env.extend(importBindings);
  }

  const exportSet = new Set(module.exports ?? []);
  const exports = new Map<string, Value>();

  // Peel let/letrec layers from module.main.
  let cur: Expr = module.main;
  let curEnv: Env = env;

  while (Array.isArray(cur) && cur.length === 3 && (cur[0] === "let" || cur[0] === "letrec")) {
    const head = cur[0];
    const bindings = cur[1];
    const body = cur[2] as Expr;
    if (!Array.isArray(bindings)) break;

    if (head === "let") {
      let stepEnv = curEnv;
      for (const binding of bindings) {
        if (!Array.isArray(binding) || binding.length !== 2) {
          // Malformed — fall back to evaluating the whole expr normally.
          return { result: evaluate(cur, curEnv), exports };
        }
        const name = binding[0];
        if (typeof name !== "string") {
          return { result: evaluate(cur, curEnv), exports };
        }
        const r = evaluate(binding[1] as Expr, stepEnv);
        if (!r.ok) return { result: r, exports };
        stepEnv = stepEnv.extend({ [name]: r.value });
        if (exportSet.has(name)) exports.set(name, r.value);
      }
      curEnv = stepEnv;
    } else {
      // letrec — placeholder pass, then fill.
      const placeholders: Record<string, Value> = {};
      const names: string[] = [];
      for (const binding of bindings) {
        if (!Array.isArray(binding) || binding.length !== 2) {
          return { result: evaluate(cur, curEnv), exports };
        }
        const name = binding[0];
        if (typeof name !== "string") {
          return { result: evaluate(cur, curEnv), exports };
        }
        names.push(name);
        placeholders[name] = NULL;
      }
      const recEnv = curEnv.extend(placeholders);
      for (let i = 0; i < bindings.length; i++) {
        const binding = bindings[i] as Expr[];
        const r = evaluate(binding[1] as Expr, recEnv);
        if (!r.ok) return { result: r, exports };
        const name = names[i] as string;
        recEnv.set(name, r.value);
        if (exportSet.has(name)) exports.set(name, r.value);
      }
      curEnv = recEnv;
    }
    cur = body;
  }

  const result = evaluate(cur, curEnv);
  return { result, exports };
}

/**
 * Evaluate a full module.
 *
 * For `lib:std` imports, each requested binding is evaluated from its
 * STD_BINDINGS expression and added to the environment before evaluating
 * `module.main`.
 *
 * For other imports, an optional `resolver` is consulted. When provided,
 * resolver returns a `Module` (or `null` for not-found) and that module is
 * recursively evaluated; values for the imported names are extracted from
 * its exports. When no resolver is provided, non-`lib:std` imports are
 * silently skipped (backward-compatible behavior).
 *
 * Variant constructors (None, Some, Ok, Err, etc.) are handled automatically
 * by the evaluator's uppercase-tag convention — no env wiring required.
 */
export function evaluateModule(module: Module, opts?: EvaluateModuleOptions): EvalResult {
  const cache = new Map<string, ModuleEvalExports>();
  return evaluateModuleExports(module, opts, cache).result;
}

// Re-export typecheckModule so callers can import both from module.ts
export { typecheckModule };
