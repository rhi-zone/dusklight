import { signal, computed } from "@rhi-zone/rainbow";
import type { Signal as RainbowSignal, ReadonlySignal } from "@rhi-zone/rainbow";
import type { ReactiveLens, Lens, Signal } from "@dusklight/core";

export function createReactiveLens<S>(initial: S): ReactiveLens<S, S> {
  const s = signal<S>(initial);
  return makeLens<S, S>(s, (f) => s.set(f(s.get())));
}

export function reactiveLensFromSignal<S>(s: RainbowSignal<S>): ReactiveLens<S, S> {
  return makeLens<S, S>(s, (f) => s.set(f(s.get())));
}

function makeLens<S, A>(
  sig: RainbowSignal<A> | ReadonlySignal<A>,
  modify: (f: (a: A) => A) => void,
): ReactiveLens<S, A> {
  return {
    signal: sig as Signal<A>,
    set(a: A) {
      modify(() => a);
    },
    modify,
    focus<B>(lens: Lens<A, B>): ReactiveLens<S, B> {
      const focused = computed(() => lens.get(sig.get()));
      return makeLens<S, B>(focused, (f) => modify((a) => lens.set(a, f(lens.get(a)))));
    },
  };
}
