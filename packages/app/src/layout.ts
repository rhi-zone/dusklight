import { subscribe, register, withScope } from "@rhi-zone/rainbow-ui/widget";
import type { LayoutNode, ReactiveLens, RendererCtx } from "@dusklight/core";
import type { PluginRegistry } from "@dusklight/core";
import { compileReactive } from "@dusklight/marinada";
import type { ReactiveEnv, ReactiveSignal } from "@dusklight/marinada";
import type { Expr } from "@dusklight/marinada";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function spacingPx(v: unknown): string {
  if (typeof v === "number") return `${v}px`;
  if (typeof v === "bigint") return `${v}px`;
  return "8px";
}

/** Compile an optional Expr to a ReactiveSignal, falling back to a constant. */
function exprSignal(expr: Expr | undefined, env: ReactiveEnv, fallback: unknown): ReactiveSignal {
  if (expr === undefined) {
    return { get: () => fallback, subscribe: () => () => {} };
  }
  return compileReactive(expr)(env);
}

/** Reactively bind a signal's value to a style property via subscribe. */
function bindStyle(el: HTMLElement, sig: ReactiveSignal, apply: (v: unknown) => void): void {
  apply(sig.get());
  subscribe(sig, apply);
}

// ---------------------------------------------------------------------------
// Layout renderer
// ---------------------------------------------------------------------------

export function renderLayout(
  node: LayoutNode,
  lens: ReactiveLens<unknown, unknown>,
  ctx: RendererCtx,
  registry: PluginRegistry,
): HTMLElement {
  // Expose the current data as "_" so layout Exprs can reference it.
  const env: ReactiveEnv = { _: lens.signal };

  switch (node.type) {
    case "HStack": {
      const el = document.createElement("div");
      el.style.display = "flex";
      el.style.flexDirection = "row";
      const gap = exprSignal(node.spacing, env, undefined);
      bindStyle(el, gap, (v) => {
        el.style.gap = spacingPx(v);
      });
      for (const child of node.children) {
        el.appendChild(renderLayout(child, lens, ctx, registry));
      }
      return el;
    }

    case "VStack": {
      const el = document.createElement("div");
      el.style.display = "flex";
      el.style.flexDirection = "column";
      const gap = exprSignal(node.spacing, env, undefined);
      bindStyle(el, gap, (v) => {
        el.style.gap = spacingPx(v);
      });
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
      const cols = exprSignal(node.columns, env, undefined);
      bindStyle(el, cols, (v) => {
        if (typeof v === "bigint" || typeof v === "number") {
          el.style.gridTemplateColumns = `repeat(${v}, 1fr)`;
        }
      });
      for (const child of node.children) {
        el.appendChild(renderLayout(child, lens, ctx, registry));
      }
      return el;
    }

    case "Spacer": {
      const el = document.createElement("div");
      el.style.flex = "1";
      if (node.minLength !== undefined) {
        const min = exprSignal(node.minLength, env, undefined);
        bindStyle(el, min, (v) => {
          el.style.minWidth = spacingPx(v);
          el.style.minHeight = spacingPx(v);
        });
      }
      return el;
    }

    case "ForEach": {
      const el = document.createElement("div");
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

      const lenSignal: ReactiveSignal<number> = {
        get: () => {
          const v = lens.signal.get();
          return Array.isArray(v) ? v.length : 0;
        },
        subscribe: (fn: (n: number) => void) =>
          lens.signal.subscribe(() => {
            const v = lens.signal.get();
            fn(Array.isArray(v) ? v.length : 0);
          }),
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
