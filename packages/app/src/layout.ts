import { subscribe, register, withScope } from "@rhi-zone/rainbow-ui/widget";
import type { LayoutNode, ReactiveLens, RendererCtx } from "@dusklight/core";
import type { PluginRegistry } from "@dusklight/core";

function spacingPx(spacing: unknown): string {
  return typeof spacing === "number" ? `${spacing}px` : "8px";
}

export function renderLayout(
  node: LayoutNode,
  lens: ReactiveLens<unknown, unknown>,
  ctx: RendererCtx,
  registry: PluginRegistry,
): HTMLElement {
  switch (node.type) {
    case "HStack": {
      const el = document.createElement("div");
      el.style.cssText = `display: flex; flex-direction: row; gap: ${spacingPx(node.spacing)}`;
      for (const child of node.children) {
        el.appendChild(renderLayout(child, lens, ctx, registry));
      }
      return el;
    }
    case "VStack": {
      const el = document.createElement("div");
      el.style.cssText = `display: flex; flex-direction: column; gap: ${spacingPx(node.spacing)}`;
      for (const child of node.children) {
        el.appendChild(renderLayout(child, lens, ctx, registry));
      }
      return el;
    }
    case "ZStack": {
      const el = document.createElement("div");
      el.style.position = "relative";
      for (const child of node.children) {
        const wrapper = document.createElement("div");
        wrapper.style.cssText = "position: absolute; inset: 0";
        wrapper.appendChild(renderLayout(child, lens, ctx, registry));
        el.appendChild(wrapper);
      }
      return el;
    }
    case "Grid": {
      const el = document.createElement("div");
      el.style.display = "grid";
      for (const child of node.children) {
        el.appendChild(renderLayout(child, lens, ctx, registry));
      }
      return el;
    }
    case "Spacer": {
      const el = document.createElement("div");
      el.style.flex = "1";
      return el;
    }
    case "ForEach": {
      const el = document.createElement("div");
      // Re-render all items when the array length changes.
      let itemCleanups: (() => void)[] = [];
      const renderItems = () => {
        for (const c of itemCleanups) c();
        itemCleanups = [];
        el.replaceChildren();
        const arr = lens.signal.get();
        if (!Array.isArray(arr)) return;
        for (let i = 0; i < arr.length; i++) {
          const itemLens = lens.focus({
            get: (a) => (a as unknown[])[i],
            set: (a, v) => {
              const copy = [...(a as unknown[])];
              copy[i] = v;
              return copy;
            },
          });
          const [child, cleanup] = withScope(() =>
            renderLayout(node.child, itemLens, ctx, registry),
          );
          itemCleanups.push(cleanup);
          el.appendChild(child);
        }
      };
      // Track length changes only to avoid full re-render on item mutations
      const lenSignal = {
        get: () => {
          const v = lens.signal.get();
          return Array.isArray(v) ? v.length : 0;
        },
        subscribe: (fn: (n: number) => void) =>
          lens.signal.subscribe(() =>
            fn(Array.isArray(lens.signal.get()) ? (lens.signal.get() as unknown[]).length : 0),
          ),
      };
      subscribe(lenSignal, renderItems);
      renderItems();
      register(() => {
        for (const c of itemCleanups) c();
      });
      return el;
    }
    case "Renderer": {
      const el = document.createElement("div");
      const renderer = registry.getRenderer(node.rendererId);
      if (!renderer) {
        el.style.color = "red";
        el.textContent = `Unknown renderer: ${node.rendererId}`;
        return el;
      }
      const cleanup = renderer.mount(el, lens, ctx);
      register(cleanup);
      return el;
    }
  }
}
