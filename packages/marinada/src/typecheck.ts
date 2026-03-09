import type { Expr } from "./types.ts"

export type TypecheckError = {
  code: string
  path: number[]
  message: string
  expected?: string
  got?: string
  suggestion?: string
}

export type TypecheckResult =
  | { ok: true }
  | { ok: false; errors: TypecheckError[] }

export function typecheck(_expr: Expr): TypecheckResult {
  // TODO: implement type checker
  return { ok: true }
}
