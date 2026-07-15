# @blockfill/orderly-exec-plugin

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
import { registerBlockfillExec } from "@blockfill/orderly-exec-plugin";

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

## Status / TODO (skeleton)

- [ ] Wire live symbol/position/holding from `@orderly.network/hooks` (`usePositionStream`,
      `useHoldingStream`) — currently assumes a flat starting position.
- [ ] Replace the static `X-API-Key` with a short-lived **session token** (wallet-signed
      challenge → `POST /execution/v1/auth/session`) — see spec §7.
- [ ] Confirm exact `@orderly.network/plugin-core` `registerPlugin` / interceptor API and
      `api`/`props` context shape against the installed SDK version.
- [ ] Add `strategy` (Maker/Taker) to the server ticket schema (spec §5), or map it to a
      strategy config on the executor.
- [ ] `pnpm install && pnpm build`; scaffold parity-check against `orderly-devkit create plugin`.
- [ ] Est. liq price / fees wiring.
