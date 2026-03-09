import type { Expr } from "./types.ts"

export type EvalError = {
  code: string
  path: number[]
  message: string
}

export type EvalResult =
  | { ok: true; value: unknown }
  | { ok: false; error: EvalError }

export function evaluate(_expr: Expr): EvalResult {
  // TODO: implement evaluator
  return { ok: false, error: { code: "NOT_IMPLEMENTED", path: [], message: "evaluator not yet implemented" } }
}
