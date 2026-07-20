# @j1998719/orderly-exec-plugin

Blockfill execution module for the **Orderly Network Module Marketplace** — a
DEX-installed plugin that adds a **TWAP / Maker–Taker order-entry panel** and routes
orders to the blockfill execution engine (smart order execution).

This is the **frontend (P2)** workstream. It is a **separate TypeScript/React repo**,
independent of the Rust venue adapter (`blockfill` executor, P1). The full design lives
in `blockfill/specs/orderly-module.md` (§7 frontend, §11 marketplace).

## Model

- **Module developer path** (no `broker_id` needed): we publish an npm package; any
  Orderly DEX installs it into their `OrderlyAppProvider`. End-users install nothing.
- The custom order form is injected at the `Trading.OrderEntry.SubmitSection`
  interceptor target.

## How a DEX installs it

```tsx
import { registerBlockfillExec } from "@j1998719/orderly-exec-plugin";

<OrderlyAppProvider brokerId="…" plugins={[registerBlockfillExec()]}>
  …
</OrderlyAppProvider>
```

Config (host page): `globalThis.BLOCKFILL_SERVER_URL` → blockfill-server endpoint.

## Data flow

```
order form (this plugin)  ──POST placeTicket──▶  blockfill-server (Execution mode)
                                                      │ mongo changestream
                                                      ▼
                                                blockfill executor ──▶ Orderly Network
```

## Structure

| File | Purpose |
|------|---------|
| `src/plugin.tsx` | `registerBlockfillExec()` — the interceptor descriptor |
| `src/OrderForm.tsx` | `BlockfillOrderPanel` — the TWAP/Maker order form (the design sketch) |
| `src/api.ts` | `placeTicket()` — blockfill-server client |
| `.orderly-manifest.json` | marketplace submission manifest |

## Build

```bash
npm install --legacy-peer-deps   # Orderly SDK pulls react-dom@19 as a transitive peer
npm run build                    # tsc → dist/
```

## Status / TODO

- [x] Typed against the real `@orderly.network/plugin-core` `OrderlyPlugin` type;
      `npm run build` produces `dist/` cleanly (interceptor `(Original, props, api)`
      shape confirmed against SDK v3.1.5).
- [x] Wire live symbol/position/holding from `@orderly.network/hooks`
      (`usePositionStream` → current `position_qty` for the symbol; `useCollateral` →
      free collateral for "Available"). `target_position` is now computed off the real
      starting position, not a flat assumption. (Type-checked against SDK v3.1.5;
      pending live verification in a host DEX.)
- [ ] Replace the static `X-API-Key` with a short-lived **session token** (wallet-signed
      challenge → `POST /execution/v1/auth/session`) — see spec §7.
- [ ] Add `strategy` (Maker/Taker) to the server ticket schema (spec §5), or map it to a
      strategy config on the executor.
- [ ] Preview live in a host DEX (`OrderlyAppProvider plugins={[registerBlockfillExec()]}`)
      on testnet; est. liq price / fees wiring.
