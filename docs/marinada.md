# Marinada

> **Status: design in progress.** Core model is settled; some details remain open (see Open Questions).

Marinada is the expression language at the core of Dusklight. It is a small, gradually-typed language designed for data manipulation and world-boundary actions.

Expressions are **JSON arrays** — s-expressions as a data structure, not a custom syntax. No custom parser required; implementations evaluate JSON directly.

The JSON array is the canonical runtime format. Programs can be loaded from anywhere — config files, API responses, user input — and evaluated dynamically. Typed constructors in TS and Rust are a dev-time authoring layer that compiles down to the same JSON arrays. The runtime doesn't know or care which path produced an expression.

Two implementations derive from this spec:
- **JS** — JITs to native JS signals (Solid.js-style). Used for JSON/text data. Owns the reactive graph in browser contexts.
- **Rust/WASM** — Bytecode + JIT. Used for binary formats and heavy computation. Computes values; JS signals layer owns reactivity in the browser. For native targets, a Rust signals system (e.g. leptos) owns reactivity instead.

Both implementations must produce identical results for all valid programs.

## Reactivity

Reactivity is a **compiler concern**, not a runtime polling concern. The compiler analyzes each expression's dependencies and emits reactive wiring — subscriptions are never written manually.

In the JS implementation, Marinada expressions compile to signals. A property expression like `["get", settings, "spacing"]` compiles to a signal that updates exactly when `settings.spacing` changes. Only affected expressions re-evaluate — no VDOM diffing, no full re-renders.

This makes layout property bindings (à la QML) first-class: any layout property can be a Marinada expression, and the compiler ensures it stays in sync with its dependencies automatically.

---

## Format

A Marinada expression is a JSON value:

- **Atom**: any JSON primitive — `42`, `3.14`, `"hello"`, `true`, `false`, `null`
- **Call**: a JSON array `[op, arg1, arg2, ...]` where `op` is a string naming the operation and args are expressions

```json
["set", "key", ["+", ["get", "key"], 1]]
```

Symbols (op names) are plain JSON strings in the first position of an array. They are not first-class values — a bare string outside the op position is a string literal.

There are no comments. Use JSON structure for clarity.

---

## Type System

Marinada is gradually typed. Every expression has a type. Types are checked before evaluation.

### Primitive Types

| Type      | Description                                      |
|-----------|--------------------------------------------------|
| `int`     | 64-bit signed integer. JS impl uses `BigInt`.    |
| `float`   | 64-bit IEEE 754 float.                           |
| `string`  | UTF-8 string                                     |
| `boolean` | `true` or `false`                                |
| `null`    | `null` — JSON-compatible nil value               |
| `unknown` | type not yet known                               |

### Compound Types

| Type           | Description                        |
|----------------|------------------------------------|
| `array<T>`     | homogeneous sequence               |
| `record<K, V>` | map from K to V                    |
| `T \| U`       | union                              |
| `bytes`        | raw byte sequence                  |

### Discriminated Unions

Marinada has native DU support. DUs are required for renderer dispatch and for modeling protocol message types, state machines, and domain variants.

```json
["type", "Color", ["Red"], ["Green"], ["Blue"]]
["type", "Shape",
  ["Circle", ["radius", "float"]],
  ["Rect",   ["width", "float"], ["height", "float"]]]
```

Constructors:
```json
["Red"]
["Circle", 1.5]
```

Pattern matching via `match` — exact, exhaustive, deterministic:
```json
["match", expr,
  [["Circle", "r"], ["*", 3.14159, ["*", "r", "r"]]],
  [["Rect", "w", "h"], ["*", "w", "h"]]]
```

The type checker enforces exhaustiveness. Non-exhaustive `match` is a compile error.

### Standard Library DUs

`option<T>` and `result<T, E>` are library DUs, not special cases:

```
option<T> = None | Some(T)
result<T, E> = Ok(T) | Err(E)
```

`null` is a JSON-compatible nil, distinct from `None`. Use `option<T>` for typed optionality, `null` when interfacing with JSON data that uses it.

### Error Handling

Errors are data. `result<T, E>` is the propagation mechanism — no exceptions.

The `?` op propagates errors up: if the inner expression is `Err`, return it immediately; if `Ok`, unwrap:

```json
["?", ["some-op-returning-result", ...]]
```

`letrec` for mutually recursive definitions (required for tree traversal):

```json
["letrec", [["f", ["fn", ["x"], ["f", "x"]]]], ["f", 0]]
```

TCO is guaranteed — implementations must not overflow the stack on tail-recursive calls. The compiler transforms tail calls; user code does not need trampolining.

### `unknown`

The default type. All external data (source output, plugin op return values without declared types) is `unknown` until narrowed.

`unknown` cannot be used directly in typed operations — it must be narrowed first via `["as", T, expr]` or `["is", T, expr]`.

### `["untyped", expr]`

Explicit escape hatch. Bypasses type checking for `expr` and all sub-expressions. Use when working with data whose shape genuinely cannot be statically described.

```json
["untyped", ["get", "data", "some-dynamic-key"]]
```

Type of `["untyped", expr]` is `unknown`.

---

## Built-in Operations

### Data Access

```json
["get", record, key]           // get field. key is string or number.
["get-in", record, path]       // get nested field. path is array<string|number>.
["set", record, key, value]    // return new record with key set to value.
["set-in", record, path, val]  // return new record with nested path set.
```

### Arithmetic

```json
["+", a, b]   ["-", a, b]   ["*", a, b]   ["/", a, b]   ["%", a, b]
```

All require `number`. Return `number`.

### Comparison

```json
["==", a, b]   ["!=", a, b]   ["<", a, b]   [">", a, b]   ["<=", a, b]   [">=", a, b]
```

`==` and `!=` accept any type. Others require `number`. All return `boolean`.

### Logic

```json
["and", a, b]   ["or", a, b]   ["not", a]
```

Require `boolean`. Return `boolean`.

### Control Flow

```json
["if", cond, then, else]
["cond", [test1, expr1], [test2, expr2], ["else", exprN]]
["do", expr1, expr2, "..."]
["let", [[name, val], "..."], expr]
```

`if`: cond must be `boolean`. then/else must have the same type.
`cond`: first matching branch is evaluated.
`do`: evaluate in sequence, return last.
`let`: bind names in scope of expr.

### Type Operations

```json
["as", "T", expr]      // assert expr is T at runtime. error if not.
["is", "T", expr]      // returns boolean. does not narrow in type checker.
["untyped", expr]      // escape hatch. see above.
```

### Collections

```json
["map", f, array]           // apply f to each element, return new array.
["filter", pred, array]     // return elements where pred returns true.
["reduce", f, init, array]  // fold.
["count", array]            // return length.
["merge", r1, r2]           // return new record with r2 keys overriding r1.
["keys", record]            // return array<string> of keys.
["vals", record]            // return array of values.
```

### String Operations

```json
["concat", s1, s2, "..."]   // concatenate strings.
["slice", s, start, end]    // substring.
["to-string", val]          // convert any primitive to string.
["parse-number", s]         // string → number | null.
```

### Function & Method Calls

```json
["call", f, arg1, arg2]           // call a function or lambda.
["call.method", cap, method, ...] // call a named method on a capability object.
```

`call.method` is a family of ops where the method name is a string argument. The type checker resolves the method signature from the capability's type.

```json
["call.method", networkCap, "get", "https://api.example.com/data"]
["call.method", storageCap, "set", "key", value]
```

---

## Capabilities

Capabilities are typed opaque objects — unforgeable values that grant authority. They are received as arguments (never constructed from within a program) and exercised via `call.method`.

### Capability Type

```
Cap<T>
```

Where `T` describes the capability's interface. A `Cap<Network>` grants network access; a `Cap<Storage>` grants storage access. The type checker knows which methods are available on each capability type.

Capabilities can be **attenuated** — a sub-expression can be handed a narrower capability (e.g. a `Cap<Network>` restricted to one host).

There is no ambient authority. A program that hasn't been handed a capability cannot exercise it.

### Built-in Capability Types

| Type              | Methods                                 |
|-------------------|-----------------------------------------|
| `Cap<Network>`    | `get`, `post`, `put`, `delete`, `ws`   |
| `Cap<Storage>`    | `get`, `set`, `delete`, `list`          |
| `Cap<LocalAgent>` | plugin-defined                          |

Plugin-defined capability types are declared in the plugin manifest alongside their method signatures, so the type checker can validate their use.

---

## Plugin Operations

Plugins register named operations at load time. A plugin op declaration:

```json
{
  "id": "kafka.produce",
  "inputs": [
    { "name": "topic", "type": "string" },
    { "name": "value", "type": "bytes" }
  ],
  "output": { "type": "null" }
}
```

Declared types are used by the type checker. If a plugin op does not declare types, its inputs and output are `unknown`.

Plugin ops are called like built-ins:

```json
["kafka.produce", "my-topic", ["as", "bytes", ["get", "msg", "payload"]]]
```

---

## Error Format

All errors include:

- **Path**: JSON path to the offending sub-expression (e.g. `[2, 1]` = second arg of third arg)
- **Code**: machine-readable error code (e.g. `TYPE_MISMATCH`, `UNKNOWN_OP`)
- **Message**: human-readable description
- **Expected / Got**: for type errors, what was expected and what was found
- **Suggestion**: optional, when a fix is obvious

Example:

```json
{
  "code": "TYPE_MISMATCH",
  "path": [1],
  "message": "expected number, got string",
  "expected": "number",
  "got": "string",
  "suggestion": "use [\"parse-number\", ...] to convert"
}
```

---

## Evaluation Model

Programs are pure data transformations with no implicit side effects. Side effects (network, mutation) only occur through explicitly declared plugin ops at world boundaries.

Evaluation order is strict (eager): arguments are evaluated before the operation.

`do` and `let` evaluate sequentially. All other operations do not guarantee evaluation order of arguments (implementations may parallelize).

---

## Typed Constructors

Implementations should provide typed builder APIs that make it impossible to construct ill-typed expressions in the host language. Type errors surface at host compile time, before Marinada's own type checker runs.

The key idea: `Expr<T>` is a phantom/branded wrapper around a JSON array where `T` is the Marinada return type of the expression.

### TypeScript

```typescript
// Branded type — T is phantom, carries no runtime value
type Expr<T> = { readonly __marinada: T } & JsonValue

// Constructors enforce types at TS compile time
declare function add(a: Expr<number>, b: Expr<number>): Expr<number>
declare function get<T>(record: Expr<Record<string, T>>, key: string): Expr<T>
declare function literal(v: number): Expr<number>
declare function literal(v: string): Expr<string>
declare function literal(v: boolean): Expr<boolean>

// Type error caught by TS, not Marinada:
add(literal("hello"), literal(1))
//  ^^^^^^^^^^^^^^^^ error: Expr<string> not assignable to Expr<number>
```

### Rust

```rust
use std::marker::PhantomData;
use serde_json::Value;

struct Expr<T> {
    inner: Value,
    _phantom: PhantomData<T>,
}

fn add(a: Expr<f64>, b: Expr<f64>) -> Expr<f64> {
    Expr { inner: json!(["+", a.inner, b.inner]), _phantom: PhantomData }
}

// Wrong type = compile error
```

`unknown` maps to a top type in each host language (`unknown` in TS, a generic `T` with no bounds in Rust). `["untyped", expr]` produces `Expr<Unknown>` — a distinct type that cannot be passed to typed ops without an explicit cast.

Plugin ops declare their input/output types as part of registration, so generated constructors for plugin ops are equally type-safe.

---

## Effects

Marinada has algebraic effects. Effects unify what would otherwise be separate language mechanisms:

| Effect    | Models                          |
|-----------|---------------------------------|
| `Error`   | Short-circuit error propagation |
| `Async`   | Suspension and resumption       |
| `Yield`   | Generators and streams          |
| Custom    | Plugin-defined effects          |

Effects are performed with `["perform", effect, payload]` and handled with `["handle", expr, handler]`. Handlers are user-defined — the language does not hardcode what effects mean.

There is no function coloring problem — effectful and pure functions are not syntactically distinguished. The type checker tracks which effects an expression may perform.

### Effect-Aware Reactivity

Reactivity is effect-aware. When a reactive computation's dependencies change, the system cancels any in-flight effects from the previous run and restarts the computation. Behavior per effect:

- **`Error`** — propagates through the reactive graph cleanly
- **`Async`** — previous continuation is cancelled, computation restarts (analogous to Solid's `createResource`)
- **`Yield`** — generator restarts from the beginning

This means reactive async data fetches, reactive streams, and reactive error propagation all work without restriction. Pure reactive computations (no effects) are a subset of this model.

### Standard Effects

`Error`, `Async`, and `Yield` are standard library effects, not language primitives. They are defined using the same effect mechanism available to plugins.

## Lambdas

```json
["fn", ["x", "y"], ["+", "x", "y"]]
```

Parameters are untyped by default (`unknown`). Optional type annotations:

```json
["fn", [["x", "int"], ["y", "int"]], ["+", "x", "y"]]
```

## Types

Type definitions (DUs, aliases) live in a separate schema/manifest, not inline in expressions. A Marinada module is a JSON object:

```json
{
  "imports": [
    { "from": "lib:std",      "import": ["option", "result"] },
    { "from": "lib:matrix",   "import": ["MatrixEvent"] },
    { "from": "local:./my-types.json", "import": ["MyType"] },
    { "from": "https://example.com/types.json", "import": ["OtherType"] }
  ],
  "types": [
    { "name": "Shape", "variants": [
      { "tag": "Circle", "fields": [["radius", "float"]] },
      { "tag": "Rect",   "fields": [["width", "float"], ["height", "float"]] }
    ]}
  ],
  "main": ["Circle", 1.5]
}
```

### Import Schemes

All imports resolve to modules the same way. No special cases.

| Scheme    | Resolves to                                      |
|-----------|--------------------------------------------------|
| `lib:`    | Named installed library (builtins, plugins, npm) |
| `local:`  | Filesystem path                                  |
| `https:`  | URL                                              |

Built-in libraries:
- `lib:std` — core data manipulation, standard DUs (`option`, `result`), standard effects
- `lib:transport` — HTTP, WebSocket, SSE, TCP
- `lib:protocol` — JSON-RPC, and other protocol primitives

### Module Exports

Exports are explicit opt-in. Nothing is exported unless listed:

```json
{
  "exports": ["MatrixEvent", "parseEvent", "MatrixSource"]
}
```

Standard library types (`option<T>`, `result<T, E>`) are defined in `lib:std` — no special cases in the language core.

## Effects — Handler Syntax

```json
["handle", expr,
  [["Yield", "val", "k"], ["do", ["collect", "val"], ["call", "k", null]]],
  [["Error", "err", "k"], ["log", "err"]],
  [["return", "x"], "x"]]
```

Each clause binds the effect payload and the continuation `k` as explicit named parameters — first-class values, no magic. `k` can be called, passed around, stored.

Continuations are **multi-shot** — they can be called zero or more times. One-shot effects (`Error`, `Async`) simply never call `k` or call it exactly once. `Yield` calls `k` once per yielded value. The type system tracks continuation linearity where declared.

## Effect Type Signatures

Effect types are **inferred** by default — the type checker tracks which effects an expression may perform without explicit annotation. Explicit annotation is optional:

```json
["fn", [["x", "int"]], ["+", "x", 1], { "effects": [] }]
["fn", [["x", "int"]], ["fetch", "x"], { "effects": ["Async", "Error"] }]
```

Unannotated functions have their effect set inferred. Annotated functions are checked against the declared set.

## Linearity

Marinada has opt-in linear and affine types. Linearity is a type modifier, applicable to any type:

| Modifier  | Constraint                          |
|-----------|-------------------------------------|
| `linear`  | Must be used exactly once           |
| `affine`  | Must be used at most once (droppable, not copyable) |
| (none)    | Unrestricted                        |

Capabilities are `linear` by default — they cannot be silently copied or dropped. Continuations are `linear` by default. Regular data is unrestricted.

```
linear Cap<Network>
linear Continuation
affine FileHandle
```

The type checker enforces linearity only where annotated. No ergonomic cost for unrestricted values.

## Open Questions

- Effect handler clause syntax — settled: `[effect-name, ...payload-bindings, k]`, `return` clause has no `k`.
- How do linear values interact with `unknown` and gradual typing?
- Linearity in DU variants — if a DU contains a linear field, does the whole DU become linear?
