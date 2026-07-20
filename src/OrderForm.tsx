/**
 * Blockfill order-entry panel — the custom TWAP / Maker–Taker order form
 * (per the design sketch) that routes to the blockfill execution engine.
 *
 * This IS a real React component (hooks allowed), rendered by the interceptor.
 */
import * as React from "react";
import { usePositionStream, useCollateral, useAccount, useConfig } from "@orderly.network/hooks";

import { placeTicket, getSession, isOnboarded, onboard, type Strategy } from "./api.js";

type OrderStyle = "LIMIT" | "MARKET" | "TWAP";
type Side = "BUY" | "SELL";

/** Timeout presets → time_constraint in ms. */
const TIMEOUT_PRESETS: Array<{ label: string; ms: number }> = [
  { label: "5m", ms: 5 * 60_000 },
  { label: "30m", ms: 30 * 60_000 },
  { label: "1h", ms: 60 * 60_000 },
  { label: "6h", ms: 6 * 60 * 60_000 },
];

/** "PERP_ETH_USDC" → { base: "ETH", quote: "USDC" }. */
function splitSymbol(sym?: string): { base: string; quote: string } {
  const parts = (sym ?? "PERP_ETH_USDC").split("_");
  return { base: parts[1] ?? "ETH", quote: parts[2] ?? "USDC" };
}

export function BlockfillOrderPanel({ symbol, api }: { symbol?: string; api?: any }) {
  const { base, quote } = splitSymbol(symbol);

  const [style, setStyle] = React.useState<OrderStyle>("TWAP");
  const [side, setSide] = React.useState<Side>("BUY");
  const [qty, setQty] = React.useState<string>(""); // base units (e.g. ETH)
  const [timeoutMs, setTimeoutMs] = React.useState<number>(TIMEOUT_PRESETS[1].ms);
  const [strategy, setStrategy] = React.useState<Strategy>("MAKER");
  const [status, setStatus] = React.useState<string>("");

  // Orderly-native symbol for this market (e.g. "PERP_ETH_USDC").
  const orderlySymbol = symbol ?? `PERP_${base}_${quote}`;

  // Live account state from the Orderly SDK (the panel is rendered inside
  // OrderlyAppProvider, so these stream hooks are in-context).
  //  - current signed position for this symbol → target_position is computed as
  //    an ABSOLUTE target off the real starting position, not a flat assumption.
  //  - free collateral → the "Available" figure shown under Buy/Sell.
  const [positionInfo] = usePositionStream(orderlySymbol);
  const currentPosition =
    positionInfo?.rows?.find((r) => r.symbol === orderlySymbol)?.position_qty ?? 0;
  const { freeCollateral } = useCollateral();
  const available = freeCollateral ?? 0;

  // Authenticated trader identity from the Orderly SDK session. The wallet
  // ADDRESS drives our own session auth (challenge → sign → Bearer token); the
  // order then executes on THIS trader's account, not a hardcoded one.
  const { account, state } = useAccount();
  const brokerId = useConfig<string>("brokerId");
  const address: string | undefined =
    (state as any)?.address ?? (account as any)?.address;

  async function onSubmit() {
    const size = Number(qty);
    if (!Number.isFinite(size) || size <= 0) {
      setStatus("Enter a valid quantity");
      return;
    }
    // Ticket target is ABSOLUTE (executor computes the delta to trade).
    const target_position = currentPosition + (side === "BUY" ? size : -size);
    const ticket = {
      exchange: "orderly" as const,
      // Orderly-native symbol (e.g. "PERP_ETH_USDC") — matches the server's
      // instrument cache (GET /v1/public/info) and the executor's parser.
      symbol: orderlySymbol,
      target_position,
      time_constraint_ms: style === "MARKET" ? 0 : timeoutMs,
      strategy, // MAKER / TAKER hint for the execution engine
    };
    try {
      // Real auth: establish a wallet-signature session (one signature prompt),
      // so the order executes on THIS connected trader's account. If no wallet
      // address is available (local/demo harness), fall back to the static key.
      let session;
      if (address && brokerId) {
        setStatus("Sign in your wallet to authorize…");
        session = await getSession(brokerId, address);
        // First time on this DEX: delegate a trading key so the executor can
        // trade this account (one extra signature; hot-onboards within ~60s).
        if (!(await isOnboarded(session))) {
          setStatus("Enabling smart execution — sign to delegate…");
          await onboard(session, brokerId, address);
        }
      }
      setStatus("Placing…");
      const res = await placeTicket(ticket, session);
      setStatus(`Ticket placed: ${res.ticket_id}`);
    } catch (e: any) {
      setStatus(`Failed: ${e?.message ?? e}`);
    }
  }

  const btn = (active: boolean) =>
    `oui-px-2 oui-py-1 oui-rounded oui-text-sm ${active ? "oui-bg-primary oui-text-white" : "oui-bg-base-6"}`;

  return (
    <div className="oui-flex oui-flex-col oui-gap-2 oui-p-2 oui-rounded-lg oui-bg-base-8">
      {/* Order style: Limit / Market / TWAP */}
      <div className="oui-flex oui-gap-2">
        {(["LIMIT", "MARKET", "TWAP"] as OrderStyle[]).map((s) => (
          <button key={s} className={btn(style === s)} onClick={() => setStyle(s)}>
            {s === "TWAP" ? "TWAP ▾" : s[0] + s.slice(1).toLowerCase()}
          </button>
        ))}
      </div>

      {/* Buy / Sell */}
      <div className="oui-flex oui-gap-2">
        <button className={btn(side === "BUY")} onClick={() => setSide("BUY")}>Buy</button>
        <button className={btn(side === "SELL")} onClick={() => setSide("SELL")}>Sell</button>
      </div>

      <div className="oui-text-xs oui-text-base-contrast-54">
        Available: {available.toFixed(2)} {quote}
      </div>

      {/* Quantity (base) */}
      <label className="oui-flex oui-flex-col oui-text-xs oui-gap-1">
        Qty
        <div className="oui-flex oui-items-center oui-gap-1 oui-border oui-rounded oui-px-2">
          <input
            className="oui-flex-1 oui-bg-transparent oui-outline-none"
            inputMode="decimal"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder="0"
          />
          <span className="oui-text-base-contrast-54">{base}</span>
        </div>
      </label>

      {/* Timeout presets (TWAP window / execution deadline) */}
      {style !== "MARKET" && (
        <div className="oui-flex oui-flex-col oui-gap-1">
          <span className="oui-text-xs">Timeout</span>
          <div className="oui-flex oui-gap-2">
            {TIMEOUT_PRESETS.map((p) => (
              <button key={p.label} className={btn(timeoutMs === p.ms)} onClick={() => setTimeoutMs(p.ms)}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Strategy: Maker / Taker */}
      <div className="oui-flex oui-flex-col oui-gap-1">
        <span className="oui-text-xs">Strategy</span>
        <div className="oui-flex oui-gap-2">
          <button className={btn(strategy === "MAKER")} onClick={() => setStrategy("MAKER")}>Maker</button>
          <button className={btn(strategy === "TAKER")} onClick={() => setStrategy("TAKER")}>Taker</button>
        </div>
      </div>

      {/* Est. liq price / fees (display; TODO wire from Orderly hooks) */}
      <div className="oui-text-xs oui-text-base-contrast-54 oui-flex oui-flex-col oui-gap-0.5">
        <span>Est. liq. price: —</span>
        <span>Fees: Taker 0.045% / Maker 0%</span>
      </div>

      <button
        className={`oui-mt-1 oui-py-2 oui-rounded oui-text-white ${side === "BUY" ? "oui-bg-success" : "oui-bg-danger"}`}
        onClick={onSubmit}
      >
        {side === "BUY" ? "Buy" : "Sell"} {base} · {style}
      </button>

      {status && <div className="oui-text-xs oui-text-base-contrast-54">{status}</div>}
    </div>
  );
}
