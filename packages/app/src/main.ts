import { PluginRegistry } from "@dusklight/core";
import type { LayoutNode } from "@dusklight/core";
import rendererJsonManifest from "@dusklight/renderer-json";
import { createApp } from "./App.ts";
import { createLayoutManifest } from "./layout-renderer.ts";

const registry = new PluginRegistry();

registry.register(rendererJsonManifest);
registry.register({
  id: "@dusklight/pattern-json-fallback",
  version: "0.1.0",
  patterns: [{ id: "json-fallback", rendererId: "@dusklight/renderer-json", match: () => 0.5 }],
});

// Demo layout: a VStack with a ForEach that iterates array items, rendering
// each item with the JSON renderer. Demonstrates end-to-end layout wiring.
const listLayout: LayoutNode = {
  type: "VStack",
  spacing: 8,
  children: [
    {
      type: "ForEach",
      // optic is required by the type but ignored by the current ForEach
      // implementation — it always iterates lens.signal.get() directly.
      optic: null,
      child: { type: "Renderer", rendererId: "@dusklight/renderer-json" },
    },
  ],
};

registry.register(
  createLayoutManifest("@dusklight/layout-list", listLayout, registry, (data) =>
    Array.isArray(data) ? 0.8 : null,
  ),
);

const root = document.getElementById("root")!;
createApp(registry, root);
