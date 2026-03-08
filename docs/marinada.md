# Marinada

Marinada is the expression language at the core of Dusklight. It is a small, gradually-typed language designed for data manipulation and world-boundary actions.

Expressions are **JSON arrays** — s-expressions as a data structure, not a custom syntax. No custom parser required; implementations evaluate JSON directly.

The JSON array is the canonical runtime format. Programs can be loaded from anywhere — config files, API responses, user input — and evaluated dynamically. Typed constructors in TS and Rust are a dev-time authoring layer that compiles down to the same JSON arrays. The runtime doesn't know or care which path produced an expression.

Two implementations derive from this spec:
- **JS** — JITs to native JS. Used for JSON/text data.
- **Rust/WASM** — Bytecode + JIT. Used for binary formats and heavy computation.

Both implementations must produce identical results for all valid programs.

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

| Type      | Description               |
|-----------|---------------------------|
| `number`  | 64-bit float              |
| `string`  | UTF-8 string              |
| `boolean` | `true` or `false`         |
| `null`    | `null`                    |
| `unknown` | type not yet known        |

### Compound Types

| Type           | Description                        |
|----------------|------------------------------------|
| `array<T>`     | homogeneous sequence               |
| `record<K, V>` | map from K to V                    |
| `T \| U`       | union                              |
| `bytes`        | raw byte sequence                  |

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

## Open Questions

- Integer vs float distinction? Currently everything is 64-bit float (like JS).
- `null` vs `option<T>` — should we have a proper option type?
- Error handling — how do errors propagate? Exceptions? Result type?
- Tail call optimization — required for recursion to be useful.
- Is recursion in scope? (`letrec`?)
