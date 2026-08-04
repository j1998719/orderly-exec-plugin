/**
 * Whether the trader has selected our TWAP order type.
 *
 * The order-type tabs and the submit section are two separate interceptor
 * injection points with no common React ancestor, so the selection lives in a
 * module-level store read through `useSyncExternalStore` rather than context.
 */
import * as React from "react";

let twapSelected = false;
const listeners = new Set<() => void>();

export function setTwapSelected(value: boolean): void {
  if (twapSelected === value) return;
  twapSelected = value;
  listeners.forEach((l) => l());
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function useTwapSelected(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => twapSelected,
    () => false, // SSR: the host may render on the server; default to the native type
  );
}
