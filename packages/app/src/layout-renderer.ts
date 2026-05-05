import { withScope } from "@rhi-zone/rainbow-ui/widget";
import { renderLayout } from "./layout.ts";
import type { LayoutNode, Renderer, PluginManifest } from "@dusklight/core";
import type { PluginRegistry } from "@dusklight/core";

/**
 * Creates a Renderer that mounts a LayoutNode tree via renderLayout.
 * The registry is closed over at creation time so nested Renderer leaf nodes
 * can look up their renderers without threading it through RendererCtx.
 */
export function createLayoutRenderer(
  id: string,
  node: LayoutNode,
  registry: PluginRegistry,
): Renderer<unknown, unknown> {
  return {
    id,
    mount(target, lens, ctx) {
      const [el, cleanup] = withScope(() => renderLayout(node, lens, ctx, registry));
      target.appendChild(el);
      return () => {
        el.remove();
        cleanup();
      };
    },
  };
}

/**
 * Convenience: create a full PluginManifest that wraps a single layout tree.
 * The manifest id and renderer id are derived from the given id.
 */
export function createLayoutManifest(
  id: string,
  node: LayoutNode,
  registry: PluginRegistry,
  match: (data: unknown) => number | null,
): PluginManifest {
  const rendererId = `${id}-renderer`;
  return {
    id,
    version: "0.1.0",
    patterns: [
      {
        id: `${id}-pattern`,
        rendererId,
        match,
      },
    ],
    renderers: [createLayoutRenderer(rendererId, node, registry)],
  };
}
