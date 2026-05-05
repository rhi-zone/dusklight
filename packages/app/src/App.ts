import { signal, computed } from "@rhi-zone/rainbow";
import type { Signal, ReadonlySignal } from "@rhi-zone/rainbow";
import * as html from "@rhi-zone/rainbow-ui/html";
import { subscribe, on, register, withScope } from "@rhi-zone/rainbow-ui/widget";
import type { PluginRegistry, PatternResult } from "@dusklight/core";
import { Pipeline } from "./pipeline.ts";
import { reactiveLensFromSignal } from "./reactive.ts";

const S = {
  app: "font-family: system-ui, sans-serif; padding: 16px; background: #1e1e1e; min-height: 100vh; color: #d4d4d4",
  h1: "margin: 0 0 8px; font-size: 18px; color: #569cd6; font-weight: 600",
  loaderRow: "display: flex; gap: 8px; align-items: center; margin-bottom: 16px",
  loaderLabel: "font-size: 13px; color: #808080",
  demoBtn:
    "padding: 4px 12px; background: #2d2d2d; color: #d4d4d4; border: 1px solid #3e3e3e; border-radius: 3px; cursor: pointer; font-size: 13px",
  rendererBar: "margin-bottom: 8px; font-size: 12px; color: #808080",
  rendererBtnActive:
    "margin-right: 4px; padding: 2px 8px; background: #569cd6; color: #d4d4d4; border: 1px solid #3e3e3e; border-radius: 3px; cursor: pointer; font-size: 12px",
  rendererBtnInactive:
    "margin-right: 4px; padding: 2px 8px; background: #2d2d2d; color: #d4d4d4; border: 1px solid #3e3e3e; border-radius: 3px; cursor: pointer; font-size: 12px",
  dataView: "background: #252526; border: 1px solid #3e3e3e; border-radius: 4px; padding: 16px",
  pre: "margin: 0; color: #d4d4d4; font-size: 13px",
};

const DEMOS = [
  { label: "Object", data: { name: "Alice", age: 30, active: true, tags: ["admin", "user"] } },
  { label: "Array", data: [1, "two", true, null, { nested: "value" }] },
  { label: "String", data: "Hello, Dusklight!" },
];

export function createApp(registry: PluginRegistry, container: HTMLElement): () => void {
  const pipeline = new Pipeline(registry);
  const data = signal<unknown | null>(null);
  const selectedRenderer = signal<string | null>(null);
  const candidates = computed(() => {
    const d = data.get();
    return d === null ? [] : pipeline.matchPatterns(d);
  });

  const [appEl, cleanup] = withScope(() => buildApp(data, selectedRenderer, candidates, registry));
  container.appendChild(appEl.node);
  return cleanup;
}

function buildApp(
  data: Signal<unknown | null>,
  selectedRenderer: Signal<string | null>,
  candidates: ReadonlySignal<PatternResult[]>,
  registry: PluginRegistry,
): html.DivEl {
  const app = html.div({ style: S.app });

  // Header
  const h1 = html.h1({ style: S.h1 }, "Dusklight");
  const loaderRow = html.div({ style: S.loaderRow });
  loaderRow.node.append(html.span({ style: S.loaderLabel }, "Load demo:").node);
  for (const demo of DEMOS) {
    const btn = html.button({ style: S.demoBtn }, demo.label);
    on(btn.node, "click", () => {
      data.set(demo.data);
      selectedRenderer.set(null);
    });
    loaderRow.node.append(btn.node);
  }
  app.node.append(h1.node, loaderRow.node);

  // Content slot — shown only when data !== null
  const contentSlot = html.div({});
  app.node.append(contentSlot.node);

  let contentCleanup: (() => void) | null = null;
  const syncContent = () => {
    const d = data.get();
    if (d !== null && contentCleanup === null) {
      const [el, c] = withScope(() => buildContent(data, selectedRenderer, candidates, registry));
      contentSlot.node.appendChild(el.node);
      contentCleanup = () => {
        el.node.remove();
        c();
      };
    } else if (d === null && contentCleanup !== null) {
      contentCleanup();
      contentCleanup = null;
    }
  };
  subscribe(data, syncContent);
  syncContent();
  register(() => contentCleanup?.());

  return app;
}

function buildContent(
  data: Signal<unknown | null>,
  selectedRenderer: Signal<string | null>,
  candidates: ReadonlySignal<PatternResult[]>,
  registry: PluginRegistry,
): html.DivEl {
  const content = html.div({});

  // Renderer selector bar
  const bar = html.div({ style: S.rendererBar });
  bar.node.append(document.createTextNode("Renderers: "));

  let btnCleanup: (() => void) | null = null;
  const syncButtons = () => {
    btnCleanup?.();
    const fragment = document.createDocumentFragment();
    const [, c] = withScope(() => {
      for (const cand of candidates.get()) {
        const active = selectedRenderer.get() === cand.rendererId;
        const btn = html.button(
          { style: active ? S.rendererBtnActive : S.rendererBtnInactive },
          `${cand.rendererId} (${Math.round(cand.confidence * 100)}%)`,
        );
        on(btn.node, "click", () => selectedRenderer.set(cand.rendererId));
        fragment.appendChild(btn.node);
      }
    });
    while (bar.node.lastElementChild) bar.node.removeChild(bar.node.lastElementChild);
    bar.node.appendChild(fragment);
    btnCleanup = c;
  };
  subscribe(candidates, syncButtons);
  subscribe(selectedRenderer, syncButtons);
  syncButtons();
  register(() => btnCleanup?.());

  // Data view panel
  const panel = html.div({ style: S.dataView });

  let mountCleanup: (() => void) | null = null;
  const syncMount = () => {
    mountCleanup?.();
    mountCleanup = null;
    const rid = selectedRenderer.get() ?? candidates.get()[0]?.rendererId ?? null;
    if (rid === null) {
      panel.node.innerHTML = `<pre style="${S.pre}">${JSON.stringify(data.get(), null, 2)}</pre>`;
      return;
    }
    const renderer = registry.getRenderer(rid);
    if (!renderer) {
      panel.node.innerHTML = `<span style="color: red">Unknown renderer: ${rid}</span>`;
      return;
    }
    panel.node.innerHTML = "";
    const lens = reactiveLensFromSignal(data as Signal<unknown>);
    mountCleanup = renderer.mount(panel.node, lens, { caps: {} });
  };
  subscribe(selectedRenderer, syncMount);
  subscribe(candidates, syncMount);
  syncMount();
  register(() => mountCleanup?.());

  content.node.append(bar.node, panel.node);
  return content;
}
