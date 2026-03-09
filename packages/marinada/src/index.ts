export type { Expr, Module } from "./types.ts";
export { typecheck } from "./typecheck.ts";
export { evaluate } from "./evaluate.ts";
export { evaluateModule, typecheckModule } from "./module.ts";
export { compile, CompileError } from "./jit.ts";
export type { JitFn } from "./jit.ts";
