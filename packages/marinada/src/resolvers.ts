import type { Module } from "./types.ts";
import { STD_MODULE } from "./std.ts";

/**
 * Resolves a module import path to its `Module` definition. Returns `null`
 * when the resolver cannot resolve the given path.
 */
export type Resolver = (path: string) => Module | null;

/**
 * Dispatches by scheme (the part before the first `:`). Extracts the protocol
 * key, looks up the handler in `handlers`, and calls it with the full path.
 * Returns null if no handler is registered for the scheme.
 *
 * @example
 * protocolResolver({
 *   lib: libStdResolver,
 *   local: localResolver("./"),
 * })
 * // "lib:std" → extracts "lib" → calls libStdResolver("lib:std")
 * // "https:..." → no handler → null
 */
export function protocolResolver(handlers: Record<string, Resolver>): Resolver {
  return (path: string): Module | null => {
    const colon = path.indexOf(":");
    if (colon === -1) return null;
    const protocol = path.slice(0, colon);
    const handler = handlers[protocol];
    if (handler === undefined) return null;
    return handler(path);
  };
}

/**
 * Exact path lookup. Returns the module if `path` is a key in `modules`,
 * null otherwise.
 *
 * @example
 * mapResolver({ "lib:mylib": myModule })
 */
export function mapResolver(modules: Record<string, Module>): Resolver {
  return (path: string): Module | null => modules[path] ?? null;
}

/**
 * Memoizes results of the inner resolver. Calls the inner resolver once per
 * path and caches the result — including null (a null result is cached as
 * null, not retried).
 */
export function cacheResolver(resolver: Resolver): Resolver {
  const cache = new Map<string, Module | null>();
  return (path: string): Module | null => {
    if (cache.has(path)) return cache.get(path) as Module | null;
    const result = resolver(path);
    cache.set(path, result);
    return result;
  };
}

/**
 * Tries each resolver in order. Returns the first non-null result, or null
 * if all resolvers return null.
 */
export function composeResolvers(...resolvers: Resolver[]): Resolver {
  return (path: string): Module | null => {
    for (const resolver of resolvers) {
      const result = resolver(path);
      if (result !== null) return result;
    }
    return null;
  };
}

/**
 * Built-in resolver that handles `lib:std`. Returns `STD_MODULE` for
 * `"lib:std"`, null for everything else.
 */
export const libStdResolver: Resolver = (path: string): Module | null => {
  if (path === "lib:std") return STD_MODULE;
  return null;
};
