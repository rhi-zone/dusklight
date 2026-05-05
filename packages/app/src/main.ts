import { PluginRegistry } from "@dusklight/core";
import rendererJsonManifest from "@dusklight/renderer-json";
import { createApp } from "./App.ts";

const registry = new PluginRegistry();

registry.register(rendererJsonManifest);
registry.register({
  id: "@dusklight/pattern-json-fallback",
  version: "0.1.0",
  patterns: [{ id: "json-fallback", rendererId: "@dusklight/renderer-json", match: () => 0.5 }],
});

const root = document.getElementById("root")!;
createApp(registry, root);
