import type { Module } from "./types.ts";
import { evaluate, EMPTY_ENV } from "./evaluate.ts";
import type { EvalResult } from "./evaluate.ts";
import { typecheckModule } from "./typecheck.ts";
import type { TypecheckResult } from "./typecheck.ts";

export type { EvalResult, TypecheckResult };

/**
 * Evaluate a full module.
 *
 * Imports at the evaluator level are stubs: the evaluator already handles any
 * uppercase-tagged call as a variant constructor, so lib:std tags (None, Some,
 * Ok, Err) just work without additional wiring. The exports list is stored for
 * future use but not enforced at this stage.
 *
 * Returns the result of evaluating module.main in the base environment.
 */
export function evaluateModule(module: Module): EvalResult {
  // The evaluator handles variant constructors via the uppercase-tag convention,
  // so no additional env wiring is required for type def variants or lib:std tags.
  // Imports from local: and https: are stubs — no runtime loading yet.
  // exports list is accessible via module.exports for future enforcement.
  return evaluate(module.main, EMPTY_ENV);
}

// Re-export typecheckModule so callers can import both from module.ts
export { typecheckModule };
