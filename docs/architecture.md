# Architecture

High-level technical design for Dusklight.

> **Status: design in progress.** This document reflects decisions made so far. Many details remain open.

---

## Core Model

Dusklight is a **projectional viewer**. Everything is data and functions over data. There is no fundamental read/write asymmetry.

World boundaries:
- **Source** (world → data): bytes arrive from somewhere
- **Renderer** (data → screen): data is projected to UI
- **Action** (data → world): data is sent somewhere

Everything in between is pure data manipulation, expressed in [Marinada](./marinada.md).

---

## Data Flow

```
Source → Parser → Pattern → Renderer
                     ↓
                  Actions
```

Each stage is pluggable. Core orchestrates, plugins implement every stage.

Schemas (OpenAPI, JTD, JSON Schema) are themselves data — they flow through the same pipeline and into `MatchContext` to inform pattern matching and rendering.

---

## Core Abstractions

### Source

Produces raw bytes + metadata. Transport is owned entirely by the source plugin — core does not know what HTTP, WebSocket, or SQLite is.

```typescript
type Source = {
  id: string
  // everything else is plugin-defined
}

type SourceResult = {
  data: AsyncIterable<Uint8Array>
  contentType?: string
  metadata?: unknown
}
```

Built-in sources: static, file.
Plugin sources: HTTP, WebSocket, SSE, SQLite (via local agent), gRPC, Matrix, IRC, etc.

### Parser

Transforms bytes into structured data.

```typescript
type Parser = {
  id: string
  contentTypes: string[]
  parse(input: AsyncIterable<Uint8Array>, ctx: ParseContext): AsyncIterable<ParseResult>
}

type ParseResult =
  | { ok: true; value: unknown; schema?: Schema }
  | { ok: false; error: string; partial?: unknown }
```

Built-in parsers: JSON, text, binary (passthrough).
Plugin parsers: protobuf, msgpack, CBOR, JSONL, custom binary formats.

### Pattern

Recognizes structure in parsed data. Suggests renderers and actions.

```typescript
type Pattern = {
  id: string
  priority: number
  match(data: unknown, ctx: MatchContext): MatchResult
}

type MatchResult =
  | { matched: false }
  | { matched: true; renderer: string; confidence: number; actions?: Action[]; children?: ChildMatch[] }
```

Patterns can be structural, heuristic, semantic, or schema-derived.

### Action

An action is a Marinada expression — pure data, fully serializable, inspectable, replayable.

```json
["call.method", cap, "post", ["get", "data", "payload"]]
```

Actions are suggested by patterns (which recognize what operations make sense for this data shape) and executed by the Marinada evaluator. Side effects only occur at world boundaries via capability objects.

### Renderer

Projects data to UI. A renderer is a projection — it receives data and produces UI. State management is the renderer's own concern; core does not classify renderers as stateful or stateless.

Complex UIs (e.g. a chat interface) are **composed from layout primitives**, not implemented as monolithic renderer plugins. The layout system arranges primitive renderers (message list, input box, send button) into complex UIs. No special-case renderers for known UI patterns.

```typescript
type Renderer = {
  id: string
  mount(target: Element, data: unknown): () => void  // returns unmount
}
```

---

## Layout & Composition

The layout system is how complex UIs are built from generic primitives. Layout is data — a tree of layout nodes referencing renderers and data sources. Marinada expressions wire data to layout nodes.

This is first-class, not an afterthought. A "chat UI" is a layout: message list renderer + input renderer + action trigger. No bespoke plugin required.

### Primitives

Inspired by SwiftUI/QML — minimal, complete, no jank. Layout is negotiated: parent offers space, child reports size, parent places.

| Primitive   | Description                              |
|-------------|------------------------------------------|
| `HStack`    | Horizontal stack. Alignment + spacing.   |
| `VStack`    | Vertical stack. Alignment + spacing.     |
| `ZStack`    | Layered/overlay. For modals, tooltips.   |
| `Grid`      | 2D grid. Explicit rows/columns.          |
| `Spacer`    | Fills available space.                   |
| `ForEach`   | Traversal over a collection. Each item gets a scoped optic. |
| `HMasonry`  | Horizontal masonry. Maybe.               |
| `VMasonry`  | Vertical masonry. Maybe.                 |

Layout nodes are JSON. CSS is an implementation detail — the layout model does not expose it.

### Data Flow via Optics

Each layout node carries an optional optic that focuses its slice of the data. Children compose their optic onto the parent's. Reads and writes both flow through the same optic — no read/write asymmetry.

`ForEach` is a traversal — an optic over a collection. Each item gets a lens focused on that element.

Optics are first-class values in Marinada (`Lens<S, A>`, `Traversal<S, A>`) with built-in composition ops:

```json
["lens.field", "messages"]     // Lens into a record field
["lens.index", 0]              // Lens into an array element
["traversal.each"]             // Traversal over all array elements
["lens.compose", l1, l2]       // Compose two optics
```

### Property Bindings

All layout properties are Marinada expressions (à la QML). The compiler tracks dependencies and emits reactive wiring automatically — a property updates exactly when its dependencies change. No manual subscriptions, no polling.

---

## Capability-Based Security

Plugins operate under the object-capability model. There is no ambient authority — a plugin can only exercise capabilities it has been explicitly handed.

Capabilities are typed opaque objects with methods, called via the `call.method` Marinada op:

```json
["call.method", networkCap, "get", "https://api.openai.com/..."]
```

A plugin that hasn't been granted `networkCap` cannot make network calls. Capabilities are values in the Marinada expression tree — authority is visible and auditable by inspecting the program.

Capability types: `Network`, `Storage`, `LocalAgent`, `PluginBridge`, and plugin-defined caps.

Capabilities can be attenuated — a plugin can hand a subset of its capabilities to a sub-expression or child plugin.

### Grant Flow

Two levels:

1. **Max set** — defined in config, established via setup wizard. The ceiling of what Dusklight itself may do (which networks, which storage, which local agents). Never exceeded.
2. **Attenuation** — UI at runtime. The user decides what each app, view, or plugin actually receives. Always a subset of the max set.

Root capabilities flow down and only ever narrow. A plugin cannot have more than what the user handed it; the user cannot grant more than the configured max.

---

## Local Agent

Some sources cannot run in-browser (SQLite, filesystem, system processes). These communicate via a **local agent** — a small process running on the user's machine that exposes a standard protocol. Source plugins talk to the agent via a `LocalAgent` capability.

`dusklight-agent` is the reference implementation. The protocol is open — any conforming agent works.

### Wire Format

**Cap'n Proto** over a Unix socket. Zero-copy, high performance, and — critically — Cap'n Proto has first-class capability support built into the protocol. Our ocap model maps directly onto the wire format; capabilities are not bolted on top.

TS clients won't get zero-copy but benefit from the schema and capability semantics. Rust (agent, native clients) gets full zero-copy.

---

## Plugin System

Plugins are ES modules exporting a manifest:

```typescript
export const manifest: PluginManifest = {
  id: 'my-plugin',
  version: '1.0.0',
  capabilities: ['network:api.example.com'],  // declared, not ambient
  parsers: [...],
  patterns: [...],
  renderers: [...],
  ops: [...],  // Marinada ops this plugin registers
}
```

Distribution: npm/jsr for published plugins, URLs for direct install, local paths for personal plugins. No custom registry.

---

## Configuration

Layered, VSCode-style:

```
defaults < user < workspace < source overrides
```

Config files are JSONC. Stored at:
- User: `~/.config/dusklight/`
- Workspace: `.dusklight/`

---

## Open Questions

- [x] ~~How do user scripts integrate?~~ No distinction — everything is a plugin.
- [x] ~~Streaming data — how do patterns work on partial data?~~ Patterns match individual items. Renderers control collection behavior (append/window/replace).
- [x] ~~Binary annotation UI~~ Layered settings. User can "promote to plugin".
- [x] ~~Schema discovery~~ Both auto-discover and explicit override. Schema flows into `MatchContext`.
- [x] ~~Plugin distribution~~ npm/jsr/URL/local. All resolve to ES modules.
- [x] ~~Control plane~~ Actions are Marinada expressions. No read/write asymmetry.
- [x] ~~Serializers~~ Not a special category — just Marinada ops that produce strings/bytes.
- [x] ~~Layout system~~ Optics for data scoping (lenses/traversals compose down the tree). Properties are Marinada expressions with compiler-emitted reactivity (signals). ForEach is a traversal.
- [x] ~~Capability grant flow~~ Two levels: (1) **max set** defined in config file via setup wizard — the ceiling of what Dusklight itself may do; (2) **attenuation** via UI at runtime — user decides what each app/view/plugin actually receives, always a subset of the max. Root capabilities only ever narrow as they flow down.
- [x] ~~Local agent protocol~~ Cap'n Proto over Unix socket. Zero-copy; capability model maps directly onto the wire format.
- [ ] Renderer mount API — needs more thought; current signature is placeholder.
