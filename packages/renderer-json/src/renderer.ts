import type { Renderer, ReactiveLens, RendererCtx } from "@dusklight/core";

/** Render any JSON value as a collapsible tree into a container element. */
export function renderJsonTree(container: Element, value: unknown): void {
  container.innerHTML = "";
  container.appendChild(createNode(value, 0));
}

function createNode(value: unknown, depth: number): Element {
  if (value === null) return makeLeaf("null", "json-null");
  if (typeof value === "boolean") return makeLeaf(String(value), "json-bool");
  if (typeof value === "number") return makeLeaf(String(value), "json-number");
  if (typeof value === "string") return makeLeaf(JSON.stringify(value), "json-string");
  if (Array.isArray(value)) return makeCollapsible(value, depth, "json-array", "[", "]");
  if (typeof value === "object")
    return makeCollapsible(value as Record<string, unknown>, depth, "json-object", "{", "}");
  return makeLeaf(String(value), "json-unknown");
}

function makeLeaf(text: string, cls: string): Element {
  const span = document.createElement("span");
  span.className = `json-value ${cls}`;
  span.textContent = text;
  return span;
}

function makeCollapsible(
  value: unknown[] | Record<string, unknown>,
  depth: number,
  cls: string,
  open: string,
  close: string,
): Element {
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as [string, unknown])
    : Object.entries(value as Record<string, unknown>);

  if (entries.length === 0) {
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = open + close;
    return span;
  }

  const wrapper = document.createElement("details");
  wrapper.className = cls;
  wrapper.open = depth < 2; // auto-expand first two levels

  const summary = document.createElement("summary");
  summary.textContent = `${open} ${entries.length} ${close}`;
  wrapper.appendChild(summary);

  const list = document.createElement("ul");
  for (const [key, val] of entries) {
    const item = document.createElement("li");
    if (!Array.isArray(value)) {
      const keySpan = document.createElement("span");
      keySpan.className = "json-key";
      keySpan.textContent = JSON.stringify(key) + ": ";
      item.appendChild(keySpan);
    }
    item.appendChild(createNode(val, depth + 1));
    list.appendChild(item);
  }
  wrapper.appendChild(list);
  return wrapper;
}

export const jsonRenderer: Renderer<unknown, unknown> = {
  id: "@dusklight/renderer-json",
  mount(target: Element, lens: ReactiveLens<unknown, unknown>, _ctx: RendererCtx): () => void {
    renderJsonTree(target, lens.signal.get());
    const unsub = lens.signal.subscribe((value) => renderJsonTree(target, value));
    return () => {
      unsub();
      target.innerHTML = "";
    };
  },
};
