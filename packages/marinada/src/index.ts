export type { Expr, Module } from "./types.ts";
export { typecheck, buildTypeInfo } from "./typecheck.ts";
export type { TypeInfo } from "./typecheck.ts";
export { evaluate } from "./evaluate.ts";
export { evaluateModule, typecheckModule } from "./module.ts";
export { compile, CompileError } from "./jit.ts";
export type { JitFn } from "./jit.ts";
export { optimize } from "./optimizer.ts";
export type { RewriteRule } from "./optimizer.ts";
