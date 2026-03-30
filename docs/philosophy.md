# Philosophy

Dusklight is a **universal UI client with a control plane**. It renders arbitrary data — and operates on it.

## Core Insight

Data has shape. Shape implies visualization. The gap between "raw JSON response" and "useful UI" is pattern recognition + rendering.

Most tools hardcode this: Swagger UI knows OpenAPI, Grafana knows metrics, pgAdmin knows tables. Dusklight inverts it: **you teach it patterns, it applies them everywhere**. And when you need to act on that data, Dusklight surfaces the right actions — not bolted-on buttons, but actions the data suggests.

## Design Principles

### 1. Pattern-First Rendering

Data flows through a recognition pipeline:

```
Source → Parse → Recognize Patterns → Select Renderer → Display
```

Patterns can match on:
- **Structure**: `{ x: number, y: number }[]` → scatter plot
- **Field names**: `*_url`, `*_image`, `*_color` → inline preview
- **Value heuristics**: large numbers in plausible timestamp range → datetime
- **Content type**: `image/*` → image viewer
- **Schema hints**: OpenAPI spec available → use it

Patterns compose. A response might match "array of objects" (→ table) where individual fields match "timestamp" (→ formatted date) and "color hex" (→ swatch).

Renderer selection is **heuristic and multi-valued** — multiple renderers may be valid for the same data. Dusklight presents ranked candidates; the user can switch. Preferences persist.

### 2. Everything is Local State

All data in Dusklight is local state. Source data arrives and is owned locally — the source keeps it synchronized with the external world, but in memory it is always locally owned and always writable.

Renderers receive a `ReactiveLens<S, A>`: a composable optic with a reactive signal on the read side and update functions on the write side. Reads are reactive (components re-render when dependencies change); writes update local state. There is no read/write asymmetry.

Two distinct update paths:
- **Lens write** → updates local state reactively
- **Action via capability** → propagates local state to the external world (network call, storage write, etc.)

A form field uses the lens. A POST button invokes a Marinada action via a capability.

### 3. Marinada: Data as Programs

Actions are [Marinada](./marinada.md) expressions — pure JSON, fully serializable, inspectable, replayable. There is no separate scripting language, no event handler soup. Everything Dusklight does to the world is an expression in a fixed, auditable language.

Marinada also wires layout property bindings reactively (à la QML), drives renderer dispatch, and encodes optics for data scoping. It is the single evaluation substrate.

### 4. Capability-Based Security

Plugins operate under the object-capability model. There is no ambient authority — a plugin can only exercise capabilities it has been explicitly handed. Authority is visible by inspecting the program; a plugin that hasn't been granted `networkCap` cannot make network calls.

### 5. Plugins Over Hardcoding

Sources, parsers, patterns, and renderers are all plugins. Core orchestrates; plugins do the work.

Plugin manifests are ES modules. Distribution: npm/jsr for published plugins, URLs for direct install, local paths for personal plugins.

### 6. Configuration as Data

Layered, VSCode-style: defaults < user < workspace < source overrides. Config files are JSONC.

## What Dusklight Is Not

- **Not an API client**: No request builder, no auth management, no collections. Use Insomnia/Postman for that.
- **Not a database UI**: No query builder, no schema browser. It renders data, not sources.
- **Not a dashboard builder**: No layout persistence, no scheduled refresh.

These boundaries keep scope manageable. Dusklight does one thing: render arbitrary data well — and act on it where the data suggests action is possible.

## Platform

TypeScript/Bun monorepo. Current packages:

- `core` — types, plugin registry, optics, reactive lens
- `marinada` — JIT compiler, type checker, evaluator, module system
- `app` — Solid.js app shell, demo UI
- `renderer-json` — collapsible JSON tree renderer
- `parser-json` / `parser-text` — built-in parsers
- `transport-http` / `transport-sse` / `transport-ws` — transport plugins

Rust/WASM for heavy binary parsing and computation. The Marinada spec defines a JS implementation (for JSON/text data) and a future Rust/WASM implementation (for binary formats) — both produce identical results.
