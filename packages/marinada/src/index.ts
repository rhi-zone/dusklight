export type { Expr, Module } from "./types.ts";
export { typecheck, buildTypeInfo } from "./typecheck.ts";
export type { TypeInfo } from "./typecheck.ts";
export { evaluate } from "./evaluate.ts";
export { evaluateModule, typecheckModule } from "./module.ts";
export { compile, compileOptimized, compileToSource, CompileError } from "./jit.ts";
export type { JitFn, CompileOptions } from "./jit.ts";
export { optimize, CONSTANT_FOLDING_RULES } from "./optimizer.ts";
export type { RewriteRule } from "./optimizer.ts";
