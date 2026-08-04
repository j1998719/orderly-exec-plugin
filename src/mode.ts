/**
 * Which custom order type is active.
 *
 * The SDK owns the selection (`onExtraSelect` / `selectedCustomTypeId`), but it
 * only hands it to some interceptor slots — the submit section does not receive
 * it. The slots also have no common React ancestor, so the active id is mirrored
 * here and read through `useSyncExternalStore`. `Trading.OrderEntry.Body`, which
 * does receive the authoritative value, keeps this in sync.
 */
import * as React from "react";

/** Our custom order type id, namespaced so it cannot collide with the SDK's. */
export const TWAP_TYPE_ID = "blockfill-twap";

let activeCustomTypeId: string | null = null;
const listeners = new Set<() => void>();

export function setActiveCustomTypeId(id: string | null): void {
  if (activeCustomTypeId === id) return;
  activeCustomTypeId = id;
  listeners.forEach((l) => l());
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function snapshot(): string | null {
  return activeCustomTypeId;
}

export function useIsTwapSelected(): boolean {
  return (
    React.useSyncExternalStore(subscribe, snapshot, () => null) === TWAP_TYPE_ID
  );
}
