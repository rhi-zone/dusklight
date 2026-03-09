import type { Parser, Pattern, Renderer, SourceFactory, PluginManifest } from "./types.ts";

export class PluginRegistry {
  private manifests = new Map<string, PluginManifest>();
  private sources = new Map<string, SourceFactory>();
  private parsers = new Map<string, Parser>();
  // keyed by content type
  private parsersByContentType = new Map<string, Parser[]>();
  private patterns: Pattern[] = [];
  private renderers = new Map<string, Renderer<unknown, unknown>>();

  register(manifest: PluginManifest): void {
    if (this.manifests.has(manifest.id)) {
      throw new Error(`Plugin already registered: ${manifest.id}`);
    }
    this.manifests.set(manifest.id, manifest);
    for (const source of manifest.sources ?? []) {
      this.sources.set(source.id, source);
    }
    for (const parser of manifest.parsers ?? []) {
      this.parsers.set(parser.id, parser);
      for (const ct of parser.contentTypes) {
        const existing = this.parsersByContentType.get(ct) ?? [];
        existing.push(parser);
        this.parsersByContentType.set(ct, existing);
      }
    }
    for (const pattern of manifest.patterns ?? []) {
      this.patterns.push(pattern);
    }
    for (const renderer of manifest.renderers ?? []) {
      this.renderers.set(renderer.id, renderer);
    }
  }

  unregister(pluginId: string): void {
    const manifest = this.manifests.get(pluginId);
    if (!manifest) return;
    this.manifests.delete(pluginId);
    for (const source of manifest.sources ?? []) {
      this.sources.delete(source.id);
    }
    for (const parser of manifest.parsers ?? []) {
      this.parsers.delete(parser.id);
      for (const ct of parser.contentTypes) {
        const existing = this.parsersByContentType.get(ct);
        if (existing) {
          const filtered = existing.filter((p) => p.id !== parser.id);
          if (filtered.length === 0) {
            this.parsersByContentType.delete(ct);
          } else {
            this.parsersByContentType.set(ct, filtered);
          }
        }
      }
    }
    this.patterns = this.patterns.filter((p) => {
      return !(manifest.patterns ?? []).some((mp) => mp.id === p.id);
    });
    for (const renderer of manifest.renderers ?? []) {
      this.renderers.delete(renderer.id);
    }
  }

  getSourceFactory(sourceId: string): SourceFactory | undefined {
    return this.sources.get(sourceId);
  }

  getManifest(pluginId: string): PluginManifest | undefined {
    return this.manifests.get(pluginId);
  }

  getParser(parserId: string): Parser | undefined {
    return this.parsers.get(parserId);
  }

  getParsersForContentType(contentType: string): Parser[] {
    return this.parsersByContentType.get(contentType) ?? [];
  }

  getRenderer(rendererId: string): Renderer<unknown, unknown> | undefined {
    return this.renderers.get(rendererId);
  }

  /** Run all patterns against data, return ranked results. */
  matchPatterns(
    data: unknown,
    ctx: import("./types.ts").MatchContext,
  ): import("./types.ts").PatternResult[] {
    const results: import("./types.ts").PatternResult[] = [];
    for (const pattern of this.patterns) {
      const score = pattern.match(data, ctx);
      if (score !== null) {
        results.push({ rendererId: pattern.rendererId, confidence: score });
      }
    }
    // Rank by confidence descending, deduplicate by rendererId (keep highest)
    const best = new Map<string, number>();
    for (const r of results) {
      const existing = best.get(r.rendererId);
      if (existing === undefined || r.confidence > existing) {
        best.set(r.rendererId, r.confidence);
      }
    }
    return Array.from(best.entries())
      .map(([rendererId, confidence]) => ({ rendererId, confidence }))
      .sort((a, b) => b.confidence - a.confidence);
  }

  listManifests(): PluginManifest[] {
    return Array.from(this.manifests.values());
  }
}
