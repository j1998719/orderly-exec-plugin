# @j1998719/twap-plugin

TWAP algorithmic execution for the **Orderly Network Module Marketplace**.

Adds a TWAP panel to the order form. Instead of sending the whole order at once,
it works the order over a duration you choose, slicing it and placing as taker or
maker. The panel replaces the order-entry body for the TWAP order type and leaves
every other order type untouched.

## Install

```tsx
import { registerTwapExec } from "@j1998719/twap-plugin";

<OrderlyAppProvider brokerId="…" plugins={[registerTwapExec()]}>
  …
</OrderlyAppProvider>
```

Set the backend endpoint on the host page:

```ts
globalThis.TWAP_SERVER_URL = "https://…";
```

Or `""` to send relative paths, when something in front of your app already
forwards `/execution` to the backend — same origin means no CORS and no mixed
content.

## Supported markets

| Symbol | Supported |
|---|---|
| `PERP_ETH_USDC` — shared market | ✅ |
| `PERP_ETH_USDC_<broker>` — broker-exclusive | ❌ |

Broker-exclusive markets are not supported. On one, the panel says so and names
the market rather than rendering a form that would fail later.

## How a request proves who it is

The browser generates an ECDSA P-256 keypair the first time you enable TWAP. Its
public half is bound to your account at the moment Orderly confirms your wallet
signed `AddOrderlyKey`; every later request carries a signature over that exact
call. Nothing reusable crosses the network — a captured request yields a
signature for one call at one instant.

The private key lives in IndexedDB as a non-extractable `CryptoKey`: script on
the page can ask it to sign but cannot read it out. Clearing site data or moving
to another browser means onboarding again.

## Layout

| File | What it is |
|---|---|
| `src/plugin.tsx` | `registerTwapExec()` — the interceptor descriptor |
| `src/OrderForm.tsx` | `TwapOrderPanel` — the TWAP order form |
| `src/api.ts` | the backend client |
| `src/signing.ts` | keypair generation, storage and request signing |
| `src/mode.ts` | the TWAP order-type id |

## Development

```bash
npm install
npm run build      # tsc → dist/
npm pack           # inspect the tarball before publishing
```
