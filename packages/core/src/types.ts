// --- Capabilities ---

/** An opaque capability object with methods, callable via Marinada's call.method op. */
export type Cap<_T> = {
  readonly id: string;
  readonly methods: Record<string, (...args: unknown[]) => unknown>;
};

// --- Sources ---

export type SourceResult = {
  data: AsyncIterable<Uint8Array>;
  contentType?: string;
  metadata?: unknown;
};

export type Source = {
  readonly id: string;
  // Sources are plugin-defined; this is the common identity contract only.
  // The source plugin's manifest registers a factory that produces SourceResult.
};

export type SourceConfig = Record<string, unknown>;

/** A source factory creates a SourceResult from a config object and capabilities. */
export type SourceFactory = {
  readonly id: string;
  /** JSON Schema describing the config object, used for wizard/UI generation. */
  readonly configSchema?: unknown;
  create(config: SourceConfig, caps: Record<string, Cap<unknown>>): SourceResult;
};

// --- Parsers ---

export type ParseContext = {
  contentType?: string;
  metadata?: unknown;
};

export type ParseResult =
  | { ok: true; value: unknown; schema?: unknown }
  | { ok: false; error: string; partial?: unknown };

export type Parser = {
  readonly id: string;
  readonly contentTypes: string[];
  parse(input: AsyncIterable<Uint8Array>, ctx: ParseContext): AsyncIterable<ParseResult>;
};

// --- Patterns ---

/** MatchContext carries schema and metadata to inform pattern matching. */
export type MatchContext = {
  schema?: unknown;
  contentType?: string;
  metadata?: unknown;
};

/**
 * A pattern scores data for renderer selection.
 * Returns a confidence in [0, 1], or null for no match.
 * This is heuristic and multi-valued — distinct from Marinada's exact/exhaustive match.
 */
export type Pattern = {
  readonly id: string;
  /** The renderer this pattern is suggesting. */
  readonly rendererId: string;
  match(data: unknown, ctx: MatchContext): number | null;
};

export type PatternResult = {
  rendererId: string;
  confidence: number;
};

// --- Optics ---

/**
 * A lens focuses on a part A of a whole S.
 * Both get and set flow through the same optic — no read/write asymmetry.
 */
export type Lens<S, A> = {
  get(s: S): A;
  set(s: S, a: A): S;
};

/**
 * A traversal focuses on zero or more parts A of a whole S.
 * ForEach layout nodes use traversals to give each item a scoped lens.
 */
export type Traversal<S, A> = {
  getAll(s: S): A[];
  modify(s: S, f: (a: A) => A): S;
};

export type Optic<S, A> = Lens<S, A> | Traversal<S, A>;

// --- Reactive Lens ---

/**
 * A signal is a reactive readable value. Inspired by Solid.js signals.
 * Concrete implementation is provided by the app shell (Solid, Preact Signals, etc.).
 */
export type Signal<A> = {
  (): A;
  readonly value: A;
};

/**
 * A reactive lens composes a Lens<S, A> with a reactive signal on the root state S.
 * All renderers receive a ReactiveLens — reads are reactive, writes update local state.
 */
export type ReactiveLens<S, A> = {
  /** Reactive signal for the focused value. */
  signal: Signal<A>;
  /** Update local state by modifying the focused value. */
  set(a: A): void;
  modify(f: (a: A) => A): void;
  /** Narrow focus further. Composes the lens. */
  focus<B>(lens: Lens<A, B>): ReactiveLens<S, B>;
};

// --- Renderers ---

export type RendererCtx = {
  caps: Record<string, Cap<unknown>>;
};

/**
 * A renderer projects data to UI.
 * mount() returns a cleanup function (called on unmount).
 */
export type Renderer<S, A> = {
  readonly id: string;
  mount(target: Element, lens: ReactiveLens<S, A>, ctx: RendererCtx): () => void;
};

// --- Layout ---

/** All layout properties are Marinada expressions. */
import type { Expr } from "@dusklight/marinada";

export type LayoutOptic = Expr; // evaluates to a Lens or Traversal at runtime

export type LayoutNode = HStack | VStack | ZStack | Grid | Spacer | ForEach | RendererLeaf;

export type HStack = {
  type: "HStack";
  alignment?: "top" | "center" | "bottom";
  spacing?: Expr;
  children: LayoutNode[];
};

export type VStack = {
  type: "VStack";
  alignment?: "leading" | "center" | "trailing";
  spacing?: Expr;
  children: LayoutNode[];
};

export type ZStack = {
  type: "ZStack";
  alignment?:
    | "topLeading"
    | "top"
    | "topTrailing"
    | "leading"
    | "center"
    | "trailing"
    | "bottomLeading"
    | "bottom"
    | "bottomTrailing";
  children: LayoutNode[];
};

export type Grid = {
  type: "Grid";
  columns: Expr;
  rows?: Expr;
  children: LayoutNode[];
};

export type Spacer = {
  type: "Spacer";
  minLength?: Expr;
};

export type ForEach = {
  type: "ForEach";
  /** Traversal optic that enumerates items. */
  optic: LayoutOptic;
  child: LayoutNode;
  keyExpr?: Expr;
};

/** Leaf node that mounts a renderer plugin. */
export type RendererLeaf = {
  type: "Renderer";
  rendererId: string;
  /** Optional optic to focus data before handing to renderer. */
  optic?: LayoutOptic;
  caps?: string[];
};

// --- Plugin Manifest ---

export type PluginManifest = {
  readonly id: string;
  readonly version: string;
  /** Declared capability requirements. Format: "capability-type:scope", e.g. "network:api.example.com" */
  readonly capabilities?: string[];
  readonly sources?: SourceFactory[];
  readonly parsers?: Parser[];
  readonly patterns?: Pattern[];
  readonly renderers?: Renderer<unknown, unknown>[];
};
