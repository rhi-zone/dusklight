export type { Expr, Module } from "./types.ts";
export { typecheck, buildTypeInfo } from "./typecheck.ts";
export type { TypeInfo } from "./typecheck.ts";
export { evaluate } from "./evaluate.ts";
export { evaluateModule, evaluateModuleRaw, typecheckModule } from "./module.ts";
export { typecheckModuleRaw } from "./typecheck.ts";
export type { ModuleResolver, EvaluateModuleOptions, TypecheckModuleOptions } from "./module.ts";
export {
  compile,
  compileOptimized,
  compileToSource,
  compileEffectful,
  CompileError,
} from "./jit.ts";
export type { JitFn, JitEffectfulFn, CompileOptions } from "./jit.ts";
export { optimize, CONSTANT_FOLDING_RULES } from "./optimizer.ts";
export type { RewriteRule } from "./optimizer.ts";
export { compileReactive } from "./reactive.ts";
export type { ReactiveEnv, ReactiveSignal, ReactiveFn } from "./reactive.ts";
export { freeVariables } from "./free-vars.ts";
export {
  protocolResolver,
  mapResolver,
  cacheResolver,
  composeResolvers,
  libStdResolver,
} from "./resolvers.ts";
export type { Resolver } from "./resolvers.ts";
